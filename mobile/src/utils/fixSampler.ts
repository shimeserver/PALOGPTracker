// Fixed deadlines: 25Hz -> 10Hz alternates 120/80ms without inventing positions.
export class FixSampler {
  private next = 0;
  private last = -Infinity;
  private hz = 0;
  reset() { this.next = 0; this.last = -Infinity; this.hz = 0; }
  accept(timestamp: number, hz: number): boolean {
    if (!Number.isFinite(timestamp) || timestamp <= this.last) return false;
    this.last = timestamp;
    const interval = 1000 / hz;
    if (this.hz !== hz || timestamp - this.next > interval * 2) {
      this.hz = hz;
      this.next = timestamp;
    }
    if (timestamp < this.next) return false;
    this.next += interval;
    return true;
  }
}
