import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { perfMonitor } from '@/shared/performance-monitor';
import { getYearCacheStats, type YearCacheStats } from '@/client/query-cache-stats';
import { featureFlags } from '@/shared/feature-flags';
import { useAllFeatureFlags } from '@/hooks/useFeatureFlag';
import { tileMonitor } from '@/shared/tile-monitor';
import type { TileState } from '@/shared/tile-monitor';

type DisplayMode = 'performance' | 'caches' | 'features' | 'tile';
type DisclosureState = 'collapsed' | 'detailed';

interface PerformanceMonitorState {
  visible: boolean;
  position: { x: number; y: number };
  disclosureState: DisclosureState;
  displayMode: DisplayMode;
}

const greenButtonStyle = {
  background: '#333',
  color: '#0f0',
  border: '1px solid #0f0',
  borderRadius: '3px',
  padding: '1px 5px',
  cursor: 'pointer',
  fontSize: '10px'
};

const redButtonStyle = {
  background: '#333',
  color: '#f00',
  border: '1px solid #f00',
  borderRadius: '3px',
  padding: '1px 5px',
  cursor: 'pointer',
  fontSize: '10px'
};

const loadPerformanceMonitorState = (): PerformanceMonitorState => {
  const defaultState: PerformanceMonitorState = {
    visible: false,
    position: { x: typeof window !== 'undefined' ? window.innerWidth / 2 - 50 : 100, y: 10 },
    disclosureState: 'collapsed',
    displayMode: 'caches'
  };

  if (typeof window === 'undefined' || !window.localStorage) {
    return defaultState;
  }

  try {
    const saved = localStorage.getItem('performance-monitor-state');
    if (saved) {
      const state = JSON.parse(saved) as Partial<PerformanceMonitorState>;
      
      // Validate and merge with defaults
      return {
        visible: state.visible === true,
        position: state.position && 
          state.position.x >= 0 && 
          state.position.x <= window.innerWidth - 100 &&
          state.position.y >= 0 && 
          state.position.y <= window.innerHeight - 100 
          ? state.position 
          : defaultState.position,
        disclosureState: state.disclosureState || defaultState.disclosureState,
        displayMode: state.displayMode || defaultState.displayMode
      };
    }
  } catch (e) {
    console.error('Failed to parse saved performance monitor state:', e);
  }

  return defaultState;
};

export const PerformanceDisplay: React.FC = () => {
  const queryClient = useQueryClient();
  const [fps, setFps] = useState(0);
  const [memory, setMemory] = useState<{ heapUsed: number; heapTotal: number } | null>(null);
  const [metrics, setMetrics] = useState<Record<string, { count: number; avgDuration: number; totalDuration: number }>>({});
  const [cacheStats, setCacheStats] = useState<YearCacheStats | null>(null);
  const [tileState, setTileState] = useState<TileState>(tileMonitor.getState());
  
  // Load all persisted state at once
  const initialState = loadPerformanceMonitorState();
  const [isVisible, setIsVisible] = useState(initialState.visible);
  const [position, setPosition] = useState(initialState.position);
  const [disclosureState, setDisclosureState] = useState(initialState.disclosureState);
  const [displayMode, setDisplayMode] = useState(initialState.displayMode);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hasDragged, setHasDragged] = useState(false);
  const [expandStage, setExpandStage] = useState<'none' | 'horizontal' | 'vertical' | 'collapsing'>('none');
  const [isAnimating, setIsAnimating] = useState(false);
  const allFeatureFlags = useAllFeatureFlags();
  const [flagsChanged, setFlagsChanged] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setFps(perfMonitor.getCurrentFPS());
      setMemory(perfMonitor.getMemoryInfo());
      setMetrics(perfMonitor.getSummary());
      
      // Update cache stats if in cache mode
      if (displayMode === 'caches') {
        setCacheStats(getYearCacheStats(queryClient));
      }
    }, 500); // Update twice per second

    return () => clearInterval(interval);
  }, [displayMode, queryClient]);

  // Subscribe to tile state changes in a separate effect that doesn't re-run
  useEffect(() => {
    const unsubscribe = tileMonitor.subscribe(() => {
      setTileState(tileMonitor.getState());
    });

    return () => unsubscribe();
  }, []); // Empty deps - only subscribe once

  const handleLogReport = () => {
    perfMonitor.logReport();
  };

  const handleClear = () => {
    perfMonitor.clear();
    setMetrics({});
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setHasDragged(false);
    setDragStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      
      setHasDragged(true);
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      // Reset hasDragged after a short delay to prevent click events
      setTimeout(() => setHasDragged(false), 100);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStart]);

  // Save all state to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      // Debounce to avoid saving during drag
      const timeoutId = setTimeout(() => {
        const state: PerformanceMonitorState = {
          visible: isVisible,
          position,
          disclosureState,
          displayMode
        };
        localStorage.setItem('performance-monitor-state', JSON.stringify(state));
      }, 100);
      
      return () => clearTimeout(timeoutId);
    }
  }, [position, isVisible, disclosureState, displayMode, isDragging]);

  // Handle keyboard shortcut (Shift+P)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'P') {
        setIsVisible(prev => !prev);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle staged expansion/collapse animation
  useEffect(() => {
    if (disclosureState === 'detailed' && expandStage === 'none' && !isAnimating) {
      // Expansion: horizontal -> pause -> vertical
      setIsAnimating(true);
      setExpandStage('horizontal');
      setTimeout(() => {
        setExpandStage('vertical');
        setTimeout(() => setIsAnimating(false), 200);
      }, 400); // 200ms horizontal + 200ms pause
    } else if (disclosureState === 'collapsed' && expandStage === 'vertical' && !isAnimating) {
      // Collapse from vertical
      setIsAnimating(true);
      setExpandStage('collapsing'); // New state that animates height down
      setTimeout(() => {
        setExpandStage('horizontal');
        // Pause
        setTimeout(() => {
          setExpandStage('none');
          setTimeout(() => setIsAnimating(false), 200);
        }, 200); // 200ms pause
      }, 200); // 200ms vertical collapse
    }
  }, [disclosureState, expandStage, isAnimating]);

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  return (
    <div 
      onMouseDown={handleMouseDown}
      style={{
        maxHeight: expandStage === 'vertical' ? '500px' : 
                   expandStage === 'collapsing' ? '40px' : '40px',
        transition: 'width 0.2s ease, min-width 0.2s ease, max-width 0.2s ease, max-height 0.2s ease, opacity 0.2s ease, border-radius 0.2s ease, padding 0.2s ease',
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        background: 'rgba(0, 0, 0, 0.8)',
        color: '#0f0',
        padding: disclosureState === 'collapsed' ? '8px' : '10px',
        borderRadius: (disclosureState === 'collapsed' && expandStage === 'none') ? '50%' : 
          (expandStage === 'none' ? '50%' : '5px'),
        fontFamily: 'monospace',
        fontSize: '12px',
        width: disclosureState === 'collapsed' && expandStage === 'none' ? '40px' : '250px',
        minWidth: disclosureState === 'collapsed' && expandStage === 'none' ? '40px' : '250px',
        maxWidth: disclosureState === 'collapsed' && expandStage === 'none' ? '40px' : '250px',
        height: 'auto',
        zIndex: 10000,
        overflow: 'hidden',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        boxSizing: 'border-box',
        opacity: disclosureState === 'collapsed' && expandStage === 'none' ? 0.2 : 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: disclosureState === 'collapsed' ? 'center' : 'stretch',
        justifyContent: disclosureState === 'collapsed' ? 'center' : 'flex-start'
      }}>
      <div style={{ marginBottom: disclosureState === 'collapsed' ? '0' : '5px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {disclosureState !== 'collapsed' && (
            <span 
              onClick={() => {
                if (!hasDragged) {
                  setDisclosureState(prev => prev === 'collapsed' ? 'detailed' : 'collapsed');
                }
              }}
              style={{ 
                cursor: 'pointer',
                marginRight: '5px',
                fontSize: '18px',
                fontFamily: 'Arial',
                display: 'inline-block',
                transform: 'rotate(90deg)', // Always rotated when expanded
                transition: 'transform 0.3s ease',
                userSelect: 'none'
              }}
            >
              ▸
            </span>
          )}
          <span 
            onClick={() => {
              if (disclosureState === 'collapsed' && !hasDragged) {
                setDisclosureState('detailed');
              }
            }}
            style={{ 
              color: fps < 30 ? '#f00' : fps < 50 ? '#ff0' : '#0f0',
              cursor: disclosureState === 'collapsed' ? 'pointer' : 'inherit',
              fontSize: disclosureState === 'collapsed' ? '14px' : '12px'
            }}
          >
            {fps.toFixed(0)}{disclosureState === 'collapsed' ? '' : 'fps'}
          </span>
        </div>
        {memory && disclosureState !== 'collapsed' && (
          <span style={{ fontSize: '11px', color: '#888' }}>
            Heap used <span style={{ fontWeight: 'bold' }}>{memory.heapUsed.toFixed(1)}/{memory.heapTotal.toFixed(1)} MB</span>
          </span>
        )}
      </div>
      
      {disclosureState !== 'collapsed' && (
        <div style={{ 
          marginBottom: '5px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '5px'
        }}>
          <div style={{ 
          display: 'inline-flex',
          border: '1px solid #0f0',
          borderRadius: '3px',
          overflow: 'hidden'
        }}>
          {(['caches', 'performance', 'features', 'tile'] as const).map((mode, index) => {
            const buttonStyle = {
              background: displayMode === mode ? '#0f0' : '#333',
              color: displayMode === mode ? '#000' : '#0f0',
              border: 'none',
              borderRight: index < 3 ? '1px solid #0f0' : 'none',
              padding: '2px 8px',
              cursor: 'pointer',
              fontSize: '11px'
            };
            
            return (
              <button
                key={mode}
                onClick={() => setDisplayMode(mode)}
                style={buttonStyle}
              >
                {mode === 'caches' ? 'Cache' : 
                 mode === 'performance' ? 'Timing' : 
                 mode === 'features' ? 'Features' : 
                 'Tile'}
              </button>
            );
          })}
        </div>
      </div>
      )}
      
      {displayMode === 'performance' && disclosureState === 'detailed' && (
        <div style={{ 
          marginTop: '10px', 
          borderTop: '1px solid #0f0',
          paddingTop: '5px'
        }}>
          <div style={{
            maxHeight: '300px', 
            overflowY: 'auto',
            marginBottom: '10px'
          }}>
          {Object.entries(metrics)
            .sort(([, a], [, b]) => b.totalDuration - a.totalDuration)
            .slice(0, 10)
            .map(([name, stats]) => (
              <div key={name} style={{ marginBottom: '5px', fontSize: '10px' }}>
                <div style={{ color: '#0f0', wordBreak: 'break-all', overflow: 'hidden' }}>{name}:</div>
                <div style={{ marginLeft: '10px', color: '#888', wordBreak: 'break-all', overflow: 'hidden' }}>
                  Count: {stats.count} | 
                  Avg: {stats.avgDuration.toFixed(1)}ms | 
                  Total: {stats.totalDuration.toFixed(0)}ms
                </div>
              </div>
            ))}
          </div>
          <div style={{ 
            display: 'flex',
            gap: '5px',
            justifyContent: 'flex-end'
          }}>
            <button 
              onClick={handleLogReport}
              style={greenButtonStyle}
            >
              Log
            </button>
            <button 
              onClick={handleClear}
              style={redButtonStyle}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      
      {displayMode === 'caches' && disclosureState === 'detailed' && (
        <div style={{ 
          marginTop: '10px', 
          borderTop: '1px solid #0f0',
          paddingTop: '5px'
        }}>
          {cacheStats ? (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', color: '#4af' }}>
                Cached: ({cacheStats.numItems} items, {(cacheStats.totalKB / 1024).toFixed(1)}MB)
              </div>
              {cacheStats.labels.length > 0 && (
                <div style={{ 
                  marginLeft: '10px', 
                  marginTop: '5px',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '4px'
                }}>
                  {cacheStats.labels.map((label: string) => (
                    <span
                      key={label}
                      style={{
                        display: 'inline-block',
                        padding: '2px 6px',
                        backgroundColor: '#224466',
                        color: '#4af',
                        borderRadius: '10px',
                        fontSize: '9px',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ marginTop: '5px' }}>
                <div style={{ fontSize: '10px', color: '#0f0', marginBottom: '3px' }}>Active:</div>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '4px',
                  minHeight: '20px',
                  marginLeft: '10px'
                }}>
                  {cacheStats.activeRequestsWithRetries && cacheStats.activeRequestsWithRetries.length > 0 ? (
                    cacheStats.activeRequestsWithRetries.map((req: { label: string; retryCount: number }) => (
                      <span
                        key={req.label}
                        style={{
                          display: 'inline-block',
                          padding: '2px 6px',
                          backgroundColor: req.retryCount > 0 ? '#550055' : '#005500',
                          color: req.retryCount > 0 ? '#f0f' : '#0f0',
                          borderRadius: '10px',
                          fontSize: '9px',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {req.label}{req.retryCount > 0 && ` (retry ${req.retryCount})`}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: '9px', color: '#666' }}>None</span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ color: '#888', fontSize: '10px' }}>No cache data available</div>
          )}
          <div style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: '10px'
          }}>
            <button
              onClick={() => {
                queryClient.clear();
                setCacheStats(getYearCacheStats(queryClient));
              }}
              style={redButtonStyle}
            >
              Clear
            </button>
          </div>
        </div>
      )}
      
      {displayMode === 'features' && disclosureState === 'detailed' && (
        <div style={{ 
          marginTop: '10px', 
          borderTop: '1px solid #0f0',
          paddingTop: '5px'
        }}>
          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            {Object.entries(allFeatureFlags).length === 0 ? (
              <div style={{ color: '#888', fontSize: '10px' }}>No feature flags defined</div>
            ) : (
              Object.entries(allFeatureFlags).map(([flag, enabled]) => (
                <label
                  key={flag}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: '#0f0'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => {
                      featureFlags.toggle(flag);
                      setFlagsChanged(true);
                    }}
                    style={{
                      width: '12px',
                      height: '12px',
                      cursor: 'pointer'
                    }}
                  />
                  <span>{flag}</span>
                </label>
              ))
            )}
          </div>
          {flagsChanged && (
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: '10px'
            }}>
              <button
                onClick={() => window.location.reload()}
                style={redButtonStyle}
              >
                Reload
              </button>
            </div>
          )}
        </div>
      )}
      
      {displayMode === 'tile' && disclosureState === 'detailed' && (
        <div style={{ 
          marginTop: '10px', 
          borderTop: '1px solid #0f0',
          paddingTop: '5px'
        }}>
          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            fontSize: '11px'
          }}>
            <div>
              <span style={{ color: '#888' }}>Offset: </span>
              <span style={{ color: '#0f0' }}>{tileState.offset}</span>
            </div>
            <div>
              <span style={{ color: '#888' }}>Overstep: </span>
              <span style={{ 
                color: tileState.overstep ? '#ff0' : '#0f0' 
              }}>
                {tileState.overstep ?? 'none'}
              </span>
            </div>
            <div>
              <span style={{ color: '#888' }}>Range: </span>
              <span style={{ color: '#0f0', fontSize: '10px' }}>
                {tileState.dateRange.start} to {tileState.dateRange.end}
              </span>
            </div>
            
            <div style={{ 
              borderTop: '1px solid #444',
              paddingTop: '4px',
              marginTop: '4px'
            }}>
              <div style={{ marginBottom: '4px' }}>
                <span style={{ color: '#888' }}>Hover offset: </span>
                <span style={{ color: '#0f0' }}>
                  {tileState.mousePosition.dayOffset ?? '-'}
                </span>
              </div>
              <div>
                <span style={{ color: '#888' }}>Hover date: </span>
                <span style={{ color: '#0f0', fontSize: '10px' }}>
                  {tileState.mousePosition.date ?? '-'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};