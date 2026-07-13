export interface CacheStats {
  numItems: number;
  totalKB: number;
  labels: string[];
  pendingLabels?: string[];
}

export interface CacheItem<T> {
  key: string;
  value: T;
  sizeInBytes: number;
  label: string;
  expiresAt?: Date;
  hitCounter: number;
}

export class LRUCache<T> {
  private cache: Map<string, CacheItem<T>> = new Map();
  private accessOrder: string[] = [];
  private maxItems: number;
  private totalBytes: number = 0;

  constructor(maxItems: number) {
    this.maxItems = maxItems;
  }

  /**
   * Get an item from the cache
   */
  get(key: string): T | undefined {
    const item = this.cache.get(key);
    
    if (item) {
      // Check if item has expired
      if (item.expiresAt && new Date() > item.expiresAt) {
        // Remove expired item
        this.removeItem(key);
        return undefined;
      }
      
      // Increment hit counter
      item.hitCounter++;
      
      // Move to end (most recently used)
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
        this.accessOrder.push(key);
      }
      return item.value;
    }
    
    return undefined;
  }

  /**
   * Set an item in the cache
   */
  set(key: string, value: T, sizeInBytes: number, label: string, expiresAt?: Date): void {
    // If item exists, preserve hit counter
    let hitCounter = 0;
    if (this.cache.has(key)) {
      const existingItem = this.cache.get(key)!;
      this.totalBytes -= existingItem.sizeInBytes;
      hitCounter = existingItem.hitCounter;
      
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
    }

    // Add to end (most recently used)
    this.accessOrder.push(key);
    this.cache.set(key, { key, value, sizeInBytes, label, expiresAt, hitCounter });
    this.totalBytes += sizeInBytes;

    // Evict if over limit
    while (this.accessOrder.length > this.maxItems) {
      this.evictOldest();
    }
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    if (!item) return false;
    
    // Check if item has expired
    if (item.expiresAt && new Date() > item.expiresAt) {
      this.removeItem(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    // Labels in access order: oldest (least recently used) first, newest last.
    const labels: string[] = [];
    for (const key of this.accessOrder) {
      const item = this.cache.get(key);
      if (item) {
        labels.push(item.label);
      }
    }

    return {
      numItems: this.cache.size,
      totalKB: this.totalBytes / 1024,
      labels
    };
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.totalBytes = 0;
  }

  /**
   * Get the current size of the cache
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Evict the oldest item from the cache
   */
  private evictOldest(): void {
    if (this.accessOrder.length === 0) return;
    
    const oldestKey = this.accessOrder.shift()!;
    const item = this.cache.get(oldestKey);
    
    if (item) {
      this.totalBytes -= item.sizeInBytes;
      this.cache.delete(oldestKey);
    }
  }
  
  /**
   * Remove a specific item from the cache
   */
  private removeItem(key: string): void {
    const item = this.cache.get(key);
    if (item) {
      this.totalBytes -= item.sizeInBytes;
      this.cache.delete(key);
      
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
    }
  }
}