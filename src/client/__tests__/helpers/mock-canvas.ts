import { vi } from 'vitest';
// Shared mock canvas implementation for tests
export class MockCanvas {
  width: number = 0;
  height: number = 0;
  
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  
  getContext() {
    return {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: '',
      textBaseline: '',
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      createImageData: vi.fn((width: number, height: number) => {
        // Create a properly aligned buffer
        const byteLength = width * height * 4;
        const buffer = new ArrayBuffer(byteLength);
        const data = new Uint8ClampedArray(buffer);
        
        return {
          data,
          width,
          height
        };
      }),
      putImageData: vi.fn()
    };
  }
}