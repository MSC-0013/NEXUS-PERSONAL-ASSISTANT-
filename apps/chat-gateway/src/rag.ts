import { MemoryRecord } from "@nexus/shared-types";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

export class LocalRAGPipeline {
  /**
   * Chunks a document into semantic passages preserving headings
   */
  public static chunkDocument(content: string, documentPath?: string, maxChars = 1000, overlap = 150): MemoryRecord[] {
    const paragraphs = content.split(/\n\s*\n/);
    const records: MemoryRecord[] = [];
    let currentChunk = "";
    let chunkIndex = 0;

    for (const para of paragraphs) {
      if ((currentChunk + "\n\n" + para).length > maxChars && currentChunk.length > 0) {
        records.push({
          id: `mem-${Date.now()}-${chunkIndex}`,
          documentPath,
          chunkIndex,
          content: currentChunk.trim(),
          tokenCount: Math.round(currentChunk.length / 4),
          createdAt: new Date().toISOString()
        });
        chunkIndex++;
        // Maintain sliding window overlap
        const words = currentChunk.split(/\s+/);
        const overlapWords = words.slice(-Math.round(overlap / 5)).join(" ");
        currentChunk = overlapWords + "\n\n" + para;
      } else {
        currentChunk = currentChunk ? currentChunk + "\n\n" + para : para;
      }
    }

    if (currentChunk.trim().length > 0) {
      records.push({
        id: `mem-${Date.now()}-${chunkIndex}`,
        documentPath,
        chunkIndex,
        content: currentChunk.trim(),
        tokenCount: Math.round(currentChunk.length / 4),
        createdAt: new Date().toISOString()
      });
    }

    return records;
  }

  /**
   * Computes cosine similarity between two float vectors
   */
  public static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * Query local Ollama embedding endpoint
   */
  public static async generateEmbedding(text: string): Promise<number[]> {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: EMBED_MODEL,
          prompt: text
        })
      });
      if (!res.ok) {
        throw new Error(`Embedding request failed: ${res.statusText}`);
      }
      const data: any = await res.json();
      return data.embedding || [];
    } catch {
      // Fallback deterministic bag-of-words hash vector for offline operation without embed model
      return this.fallbackHashVector(text, 128);
    }
  }

  private static fallbackHashVector(text: string, dims = 128): number[] {
    const vec = new Array(dims).fill(0);
    const words = text.toLowerCase().match(/\b\w+\b/g) || [];
    for (const w of words) {
      let h = 0;
      for (let i = 0; i < w.length; i++) {
        h = (h * 31 + w.charCodeAt(i)) & 0xffffffff;
      }
      const idx = Math.abs(h) % dims;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return norm > 0 ? vec.map(v => v / norm) : vec;
  }
}
