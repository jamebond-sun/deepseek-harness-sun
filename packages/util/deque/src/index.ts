/**
 * 零依赖的循环双端队列，用于跨异步工作保留条目的队列。
 * @module @deepseek-ai/dsh-deque
 */

const MIN_CAPACITY = 16

/**
 * 循环双端队列，插入与移除均为摊还常量时间。
 * 被移除的条目会立即清除，而当活动条目数降到容量的四分之一时，
 * 稀疏存储会收缩。
 */
export class Deque<T> {
  private buffer = new Array<T | undefined>(MIN_CAPACITY)
  private head = 0
  private count = 0

  /** 可移除的条目数量。 */
  get size(): number {
    return this.count
  }

  /**
   * 在当前尾部之后追加一个条目。
   * @param value - 待追加的条目。
   */
  pushBack(value: T): void {
    this.ensureCapacity()
    const tail = this.head + this.count
    this.buffer[tail < this.buffer.length ? tail : tail - this.buffer.length] = value
    this.count += 1
  }

  /**
   * 在当前头部之前插入一个条目。
   * @param value - 待前置的条目。
   */
  pushFront(value: T): void {
    this.ensureCapacity()
    this.head = this.head === 0 ? this.buffer.length - 1 : this.head - 1
    this.buffer[this.head] = value
    this.count += 1
  }

  /**
   * 移除当前头部条目并清除其保留的引用。
   * 元素类型包含 `undefined` 的调用方应使用 {@link size} 来区分空
   * 队列与 `undefined` 条目。
   * @returns 被移除的条目，队列为空时为 `undefined`。
   */
  popFront(): T | undefined {
    if (this.count === 0) return undefined
    const value = this.buffer[this.head] as T
    this.buffer[this.head] = undefined
    this.head += 1
    if (this.head === this.buffer.length) this.head = 0
    this.count -= 1
    this.compact()
    return value
  }

  /** 丢弃所有条目并释放当前的后备存储。 */
  clear(): void {
    this.buffer = new Array<T | undefined>(MIN_CAPACITY)
    this.head = 0
    this.count = 0
  }

  private ensureCapacity(): void {
    if (this.count < this.buffer.length) return
    this.resize(this.buffer.length * 2)
  }

  private compact(): void {
    if (this.count === 0) {
      this.head = 0
      return
    }
    if (this.buffer.length > MIN_CAPACITY && this.count <= this.buffer.length / 4) {
      this.resize(Math.max(MIN_CAPACITY, this.buffer.length / 2))
    }
  }

  private resize(capacity: number): void {
    const next = new Array<T | undefined>(capacity)
    let source = this.head
    for (let index = 0; index < this.count; index += 1) {
      next[index] = this.buffer[source]
      source += 1
      if (source === this.buffer.length) source = 0
    }
    this.buffer = next
    this.head = 0
  }
}
