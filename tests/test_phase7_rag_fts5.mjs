import * as fs from "fs";
import * as path from "path";
import { NexusDatabase } from "../apps/chat-gateway/dist/db.js";
import { LocalRAGPipeline } from "../apps/chat-gateway/dist/rag.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test_database", "nexus_phase7_rag.sqlite");

async function runPhase7Tests() {
  console.log("==================================================================");
  console.log("   PROJECT NEXUS V2.3 — PHASE 7: PERSONAL MEMORY & FTS5 RAG SUITE");
  console.log("==================================================================");

  // Clean test files
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  const walPath = `${TEST_DB_PATH}-wal`;
  const shmPath = `${TEST_DB_PATH}-shm`;
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

  fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
  const db = new NexusDatabase(TEST_DB_PATH);

  const results = [];

  // Sample markdown document
  const sampleDoc = `
# Project NEXUS Sovereign Manifesto

NEXUS operates as an air-gapped sovereign artificial intelligence assistant.
All model weights, vector representations, and SQLite persistent databases reside solely on local NVMe storage.

## Cryptographic Guarantees
Every action proposal is evaluated through an HMAC-SHA256 audit anchor sidecar.
Path traversal exploits and arbitrary command injections are strictly eliminated by contract.

## Personal Workflow
The user prefers strict TypeScript interfaces and deterministic tool invocation.
`;

  // -----------------------------------------------------------------
  // ASSERTION 1: Chunking & Trigger-based FTS5 Insert Synchronization
  // -----------------------------------------------------------------
  console.log("[ASSERTION 1/5] Testing LocalRAGPipeline chunking & trigger-based FTS5 insert...");
  const docId = `doc-${Date.now()}`;
  const filepath = "workspace/docs/manifesto.md";
  const rawChunks = LocalRAGPipeline.chunkDocument(sampleDoc, filepath, 200, 30);
  console.log(`Document chunked into ${rawChunks.length} passages.`);

  const chunksToInsert = rawChunks.map((rc, idx) => ({
    id: `chunk-${Date.now()}-${idx}`,
    chunkIndex: idx,
    content: rc.content,
    tokenCount: rc.tokenCount
  }));

  db.ingestDocument(docId, "manifesto.md", filepath, sampleDoc, chunksToInsert);

  // Search FTS5 for "sovereign"
  const ftsSearch1 = db.searchFTS("sovereign", 5);
  console.log(`FTS5 search results for 'sovereign': ${ftsSearch1.length}`);
  const pass1 = ftsSearch1.length > 0 && ftsSearch1[0].filepath === filepath;
  results.push({ assertion: "FTS5 Insert Trigger", passed: pass1, hits: ftsSearch1.length });
  if (!pass1) throw new Error("FTS5 insert trigger synchronization failed!");
  console.log("--> PASS: Automatic trigger insertion into FTS5 index verified.\n");

  // -----------------------------------------------------------------
  // ASSERTION 2: Trigger-based FTS5 Update Synchronization
  // -----------------------------------------------------------------
  console.log("[ASSERTION 2/5] Testing trig_chunks_au update synchronization...");
  const targetChunk = chunksToInsert[1];
  const updatedContent = "Exclusive HMAC cryptographic anchor chain with zero telemetry.";
  db.updateChunkContent(targetChunk.id, updatedContent);

  const updateSearchNew = db.searchFTS("telemetry", 5);
  console.log(`FTS5 search for updated keyword 'telemetry': ${updateSearchNew.length} hits`);
  const pass2 = updateSearchNew.length > 0 && updateSearchNew[0].content.includes("zero telemetry");
  results.push({ assertion: "FTS5 Update Trigger", passed: pass2, hits: updateSearchNew.length });
  if (!pass2) throw new Error("FTS5 update trigger synchronization failed!");
  console.log("--> PASS: Update trigger successfully refreshed FTS5 index.\n");

  // -----------------------------------------------------------------
  // ASSERTION 3: Trigger-based FTS5 Delete Synchronization
  // -----------------------------------------------------------------
  console.log("[ASSERTION 3/5] Testing trig_chunks_ad delete synchronization...");
  // Delete chunk 0 from document_chunks
  const chunk0 = chunksToInsert[0];
  db.db.prepare("DELETE FROM document_chunks WHERE id = ?").run(chunk0.id);

  // Search for unique keyword from chunk 0 ("manifesto")
  const deleteSearch = db.searchFTS("manifesto", 5);
  console.log(`FTS5 search for deleted chunk keyword 'manifesto': ${deleteSearch.length} hits`);
  const pass3 = deleteSearch.length === 0;
  results.push({ assertion: "FTS5 Delete Trigger", passed: pass3, hits: deleteSearch.length });
  if (!pass3) throw new Error("FTS5 delete trigger synchronization failed!");
  console.log("--> PASS: Delete trigger automatically purged deleted chunk from FTS5 index.\n");

  // -----------------------------------------------------------------
  // ASSERTION 4: Foreign Key Cascade Deletion to FTS5
  // -----------------------------------------------------------------
  console.log("[ASSERTION 4/5] Testing Foreign Key CASCADE deletion from documents...");
  db.deleteDocument(docId);

  const remainingChunks = db.db.prepare("SELECT count(*) as count FROM document_chunks WHERE document_id = ?").get();
  const ftsSearchPostDocDelete = db.searchFTS("cryptographic", 5);
  console.log(`Remaining chunks in table: ${remainingChunks.count}`);
  console.log(`Remaining FTS5 matches: ${ftsSearchPostDocDelete.length}`);

  const pass4 = remainingChunks.count === 0 && ftsSearchPostDocDelete.length === 0;
  results.push({ assertion: "Cascade Deletion", passed: pass4, remainingChunks: remainingChunks.count });
  if (!pass4) throw new Error("Cascade deletion to FTS5 failed!");
  console.log("--> PASS: Cascade deletion purged document, chunks, and FTS5 entries cleanly.\n");

  // -----------------------------------------------------------------
  // ASSERTION 5: PRAGMA secure_delete & Memory Zeroing on Disk
  // -----------------------------------------------------------------
  console.log("[ASSERTION 5/5] Testing PRAGMA secure_delete & physical disk zeroing...");
  const secretKey = "SECRET_TOKEN_ALPHA_778899_SENSITIVE";
  const memId = `mem-secret-${Date.now()}`;
  db.addMemory(memId, "preference", `The secret user credential is ${secretKey}`);

  // Confirm memory is readable
  const retrievedMem = db.getMemories("preference");
  const memExists = retrievedMem.some((m) => m.content.includes(secretKey));
  console.log(`Memory saved and retrieved successfully: ${memExists}`);

  // Delete memory
  db.deleteMemory(memId);
  console.log("[INFO] Memory deleted via DELETE FROM memories.");

  // Checkpoint WAL into database file and truncate WAL
  db.checkpointTruncate();
  db.close();

  // Read raw binary disk pages
  const dbBytes = fs.readFileSync(TEST_DB_PATH);
  const dbString = dbBytes.toString("binary");
  const foundSecret = dbString.includes(secretKey);
  console.log(`Physical scan of sqlite file: Secret present in raw disk bytes: ${foundSecret}`);

  const pass5 = memExists && !foundSecret;
  results.push({ assertion: "Disk Zeroing (secure_delete)", passed: pass5, foundOnDisk: foundSecret });
  if (!pass5) throw new Error("Deleted sensitive memory was found in plain text on disk! secure_delete failed!");
  console.log("--> PASS: Deleted data verified completely zeroed from physical disk pages.\n");

  console.log("==================================================================");
  console.log("   PHASE 7 VERIFICATION: ALL 5 FTS5/MEMORY ASSERTIONS PASSED (100%)");
  console.log("==================================================================");

  const report = {
    phase: 7,
    timestamp: new Date().toISOString(),
    status: "PASS",
    results
  };
  fs.writeFileSync("tests/phase7_test_report.json", JSON.stringify(report, null, 2));
  console.log("[INFO] Wrote report to tests/phase7_test_report.json");
}

runPhase7Tests().catch((err) => {
  console.error("PHASE 7 FATAL ERROR:", err);
  process.exit(1);
});
