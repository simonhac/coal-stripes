/**
 * Tests for MasterSession JSON dump functionality
 */

import { SessionManager } from '../SessionManager';
import { MasterSession } from '../MasterSession';
import { SessionType } from '../types';

describe('MasterSession JSON Dump', () => {
  let manager: SessionManager;
  let consoleSpy: jest.SpyInstance;
  let jsonDump: any;

  beforeEach(() => {
    // Get a fresh instance by clearing the singleton
    (SessionManager as any).instance = undefined;
    manager = SessionManager.getInstance();
    jest.useFakeTimers();
    jsonDump = undefined;

    // Silence the debug logging.
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // In production the dump is POSTed to the dashboard, but that path is gated
    // on a browser environment + feature flag and doesn't run under the node
    // test env. Capture the dump structure directly when the MasterSession ends.
    jest.spyOn(MasterSession.prototype, 'end').mockImplementation(function (this: MasterSession) {
      jsonDump = this.toJSON();
    });
  });

  afterEach(() => {
    // Clean up any active sessions
    const activeSessions = (manager as any).activeSessions as Map<SessionType, any>;
    for (const session of activeSessions.values()) {
      if (session.isActive()) {
        session.end();
      }
    }
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('JSON structure', () => {
    it('should dump complete MasterSession data when all sessions end', () => {
      // Create sessions
      const wheel = manager.createSession(SessionType.WHEEL);
      const move = manager.createSession(SessionType.MOVE);
      
      // Create events
      wheel.startPhase('SCROLL');
      (wheel as any).createWheelEvent('SCROLL', 10.5, 100).log();
      wheel.endPhase('SCROLL', 'completed');
      
      move.startPhase('DRAG');
      (move as any).createMoveMessage('DRAG', 'pos=2025-08-05, v=5.0').log();
      move.endPhase('DRAG', 'completed');
      
      // End all sessions to trigger dump
      wheel.end();
      move.end();
      
      // Verify JSON structure
      expect(jsonDump).toBeDefined();
      expect(jsonDump.masterSessionId).toBe(1);
      expect(jsonDump.totalSessions).toBe(2);
      expect(jsonDump.sessions).toHaveLength(2);
      expect(typeof jsonDump.startTime).toBe('number');
      expect(typeof jsonDump.endTime).toBe('number');
      expect(typeof jsonDump.duration).toBe('number');
    });

    it('should include all session details in the dump', () => {
      const wheel = manager.createSession(SessionType.WHEEL);
      
      wheel.startPhase('SCROLL');
      (wheel as any).createWheelEvent('SCROLL', 10.5, 100).log();
      wheel.endPhase('SCROLL', 'completed');
      
      wheel.end();
      
      const wheelSession = jsonDump.sessions[0];
      expect(wheelSession.sessionId).toBe('1a-WHEEL');
      expect(wheelSession.type).toBe('WHEEL');
      expect(wheelSession.identifier).toBe('a');
      expect(wheelSession.eventCount).toBe(1);
      expect(wheelSession.events).toHaveLength(1);
      expect(wheelSession.active).toBe(false);
    });

    it('should include event details with warnings', () => {
      const wheel = manager.createSession(SessionType.WHEEL);
      
      wheel.startPhase('SCROLL');
      const event = (wheel as any).createWheelEvent('SCROLL', 10.5, 100);
      event.addWarning('MOMENTUM_LOST');
      event.addWarning('THRESHOLD_EXCEEDED');
      event.log();
      wheel.endPhase('SCROLL', 'completed');
      
      wheel.end();
      
      const wheelEvent = jsonDump.sessions[0].events[0];
      expect(wheelEvent.sessionId).toBe('1a-WHEEL');
      expect(wheelEvent.phase).toBe('SCROLL');
      expect(wheelEvent.eventSeq).toBe(0);
      expect(wheelEvent.data.deltaX).toBe(10.5);
      expect(wheelEvent.data.accumulatedX).toBe(100);
      expect(wheelEvent.warnings).toEqual(['MOMENTUM_LOST', 'THRESHOLD_EXCEEDED']);
    });

    it('should handle multiple session types', () => {
      const wheel = manager.createSession(SessionType.WHEEL);
      const move = manager.createSession(SessionType.MOVE);
      const touch = manager.createSession(SessionType.TOUCH);
      
      // Add events to each
      wheel.startPhase('SCROLL');
      (wheel as any).createWheelEvent('SCROLL', 1.0, 10).log();
      wheel.endPhase('SCROLL', 'done');
      
      move.startPhase('DRAG');
      (move as any).createMoveMessage('DRAG', 'test').log();
      move.endPhase('DRAG', 'done');
      
      touch.startPhase('PINCH');
      (touch as any).createTouchEvent('PINCH', 100, 200, 10, 20, 2).log();
      touch.endPhase('PINCH', 'done');
      
      // End all
      wheel.end();
      move.end();
      touch.end();
      
      expect(jsonDump.totalSessions).toBe(3);
      expect(jsonDump.sessions.map((s: any) => s.type)).toEqual(['WHEEL', 'MOVE', 'TOUCH']);
      expect(jsonDump.sessions.map((s: any) => s.sessionId)).toEqual(['1a-WHEEL', '1a-MOVE', '1a-TOUCH']);
    });

    it('should round all times to integers', () => {
      const wheel = manager.createSession(SessionType.WHEEL);
      
      wheel.startPhase('SCROLL');
      (wheel as any).createWheelEvent('SCROLL', 10.5, 100).log();
      wheel.endPhase('SCROLL', 'completed');
      
      wheel.end();
      
      // Check MasterSession times
      expect(Number.isInteger(jsonDump.startTime)).toBe(true);
      expect(Number.isInteger(jsonDump.endTime)).toBe(true);
      expect(Number.isInteger(jsonDump.duration)).toBe(true);
      
      // Check session times
      const session = jsonDump.sessions[0];
      expect(Number.isInteger(session.startTime)).toBe(true);
      expect(Number.isInteger(session.duration)).toBe(true);
      expect(Number.isInteger(session.masterSessionDeltaMs)).toBe(true);
      
      // Check event times
      const event = session.events[0];
      expect(Number.isInteger(event.elapsedMs)).toBe(true);
    });

    it('should mark active sessions correctly', () => {
      const wheel = manager.createSession(SessionType.WHEEL);
      const move = manager.createSession(SessionType.MOVE);
      
      wheel.startPhase('SCROLL');
      move.startPhase('DRAG');
      
      // End only wheel
      wheel.end();
      
      // Move is still active, but MasterSession shouldn't end yet
      expect((manager as any).currentMasterSession).toBeTruthy();
      
      // Now end move to trigger dump
      move.end();
      
      // Check that sessions are marked correctly
      const wheelSession = jsonDump.sessions.find((s: any) => s.type === 'WHEEL');
      const moveSession = jsonDump.sessions.find((s: any) => s.type === 'MOVE');
      
      expect(wheelSession.active).toBe(false);
      expect(moveSession.active).toBe(false);
      expect(wheelSession.endTime).toBeDefined();
      expect(moveSession.endTime).toBeDefined();
    });

    it('should include events without warnings correctly', () => {
      const wheel = manager.createSession(SessionType.WHEEL);
      
      wheel.startPhase('SCROLL');
      const event1 = (wheel as any).createWheelEvent('SCROLL', 10.5, 100);
      event1.log();
      
      const event2 = (wheel as any).createWheelEvent('SCROLL', 5.0, 105);
      event2.addWarning('TEST_WARNING');
      event2.log();
      wheel.endPhase('SCROLL', 'completed');
      
      wheel.end();
      
      const events = jsonDump.sessions[0].events;
      expect(events[0].warnings).toBeUndefined(); // No warnings
      expect(events[1].warnings).toEqual(['TEST_WARNING']); // Has warnings
    });
  });

  describe('Multiple MasterSessions', () => {
    it('should create new MasterSession after previous one ends', () => {
      // First MasterSession
      const wheel1 = manager.createSession(SessionType.WHEEL);
      wheel1.startPhase('SCROLL');
      (wheel1 as any).createWheelEvent('SCROLL', 1.0, 10).log();
      wheel1.endPhase('SCROLL', 'done');
      wheel1.end();
      
      // Capture first dump
      const firstDump = { ...jsonDump };
      
      // Second MasterSession
      const wheel2 = manager.createSession(SessionType.WHEEL);
      wheel2.startPhase('SCROLL');
      (wheel2 as any).createWheelEvent('SCROLL', 2.0, 20).log();
      wheel2.endPhase('SCROLL', 'done');
      wheel2.end();
      
      // Capture second dump
      const secondDump = { ...jsonDump };
      
      expect(firstDump.masterSessionId).toBe(1);
      expect(secondDump.masterSessionId).toBe(2);
      expect(firstDump.sessions[0].sessionId).toBe('1a-WHEEL');
      expect(secondDump.sessions[0].sessionId).toBe('2a-WHEEL');
    });
  });
});