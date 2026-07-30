// ============================================================
// Memory Types
// ============================================================

export interface MemoryEntry {
  timestamp: string
  summary: string
}

export interface MemoryContent {
  entries: MemoryEntry[]
  /** Get formatted memory text for AI system prompt */
  toString(): string
}
