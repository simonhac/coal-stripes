/**
 * Dynamic feature flags management system
 */

class FeatureFlagsStore {
  private static instance: FeatureFlagsStore;
  private flags: Map<string, boolean> = new Map();
  private listeners: Set<() => void> = new Set();

  private constructor() {
    // Load flags from localStorage if available
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = localStorage.getItem('featureFlags');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          Object.entries(parsed).forEach(([key, value]) => {
            if (typeof value === 'boolean') {
              this.flags.set(key, value);
            }
          });
        } catch (e) {
          console.error('Failed to parse stored feature flags:', e);
        }
      }
    }
  }

  static getInstance(): FeatureFlagsStore {
    if (!FeatureFlagsStore.instance) {
      FeatureFlagsStore.instance = new FeatureFlagsStore();
    }
    return FeatureFlagsStore.instance;
  }

  get(flag: string): boolean {
    // If flag doesn't exist, create it with default value false
    if (!this.flags.has(flag)) {
      this.flags.set(flag, false);
      this.persist();
    }
    return this.flags.get(flag)!;
  }

  set(flag: string, value: boolean): void {
    const currentValue = this.flags.get(flag);
    if (currentValue !== value) {
      this.flags.set(flag, value);
      this.persist();
      this.notifyListeners();
    }
  }

  toggle(flag: string): void {
    this.set(flag, !this.get(flag));
  }

  getAll(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    this.flags.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  getAllFlags(): string[] {
    return Array.from(this.flags.keys()).sort();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }

  private persist(): void {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem('featureFlags', JSON.stringify(this.getAll()));
    }
  }
}

export const featureFlags = FeatureFlagsStore.getInstance();