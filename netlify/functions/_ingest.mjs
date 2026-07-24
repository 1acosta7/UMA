import { extractText } from "unpdf";
import { PDFDocument } from "pdf-lib";
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const EMBEDDING_MODEL = "text-embedding-3-small";

// Classifies every page of a carrier guideline PDF as table-heavy (rate-class
// tables, numeric underwriting grids, build charts, age/amount matrices) or
// narrative (process guidance, exclusion criteria, eligibility language).
// One batched call regardless of page count, not one call per page.
const CLASSIFY_SYSTEM = `You are classifying pages of an insurance underwriting guideline PDF. For each page, decide:
- "table": the page is dominated by a rate-class table, numeric underwriting grid, build/BMI chart, or age/amount matrix -- short condition names or numeric labels paired with columns of Yes/checkmarks/rate-class codes, even if PDF text extraction has flattened the columns into a stream of short tokens.
- "narrative": the page is dominated by prose -- underwriting philosophy, process instructions, exclusion criteria, informal inquiry guidance, eligibility rules, or similar connected sentences.
A page with a short intro sentence above a table is still "table" if the bulk of its content is tabular data.
Return JSON only: {"pages": [{"page": 1, "type": "table"}, {"page": 2, "type": "narrative"}, ...]} -- one entry for every page number given, in order.`;

// Supabase/OpenAI clients are constructed lazily, inside the narrative-
// embedding step's own try/catch below, so a missing or not-yet-configured
// SUPABASE_URL/SUPABASE_SERVICE_KEY/OPENAI_API_KEY degrades to "this upload's
// narrative content just isn't searchable yet" rather than failing the
// upload outright -- the table-PDF half of ingestion has nothing to do with
// this infrastructure and should always succeed independent of it.

async function classifyPages(anthropic, pages) {
  const preview = pages
    .map((text, i) => `=== PAGE ${i + 1} ===\n${text.slice(0, 600)}`)
    .join("\n\n");
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: Math.max(500, pages.length * 20),
      system: CLASSIFY_SYSTEM,
      messages: [{ role: "user", content: preview }],
    });
    const text = msg.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    const byPage = new Map((parsed.pages || []).map((p) => [p.page, p.type]));
    return pages.map((_, i) => byPage.get(i + 1) === "table" ? "table" : "narrative");
  } catch {
    // If classification fails outright, default every page to "table" --
    // safer to over-preserve as native PDF than to silently chunk content
    // that might be a rate table we failed to recognize.
    return pages.map(() => "table");
  }
}

// Splits narrative page text into paragraph-sized chunks (~800-1400 chars),
// never mid-paragraph, so a chunk is never split mid-thought.
function chunkPage(pageText, maxLen = 1200) {
  const paragraphs = pageText.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    if (current && (current.length + para.length + 1) > maxLen) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current} ${para}` : para;
    }
    while (current.length > maxLen * 1.5) {
      chunks.push(current.slice(0, maxLen));
      current = current.slice(maxLen);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function embedBatch(openai, texts) {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function extractTablePdf(buf, tablePageNumbers) {
  // Several carrier guides ship with basic PDF permission restrictions
  // ("Producer Use Only" viewer locks, no real content encryption) --
  // pdf-lib refuses to load those without this flag even though there's
  // nothing to decrypt.
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const dest = await PDFDocument.create();
  const indices = tablePageNumbers.map((n) => n - 1);
  const copied = await dest.copyPages(src, indices);
  copied.forEach((p) => dest.addPage(p));
  return Buffer.from(await dest.save());
}

// Runs the full hybrid ingestion pipeline for one uploaded carrier PDF:
// classify each page, keep table-heavy content as native PDF (sliced to just
// those pages if the document is mixed), and chunk+embed narrative pages into
// Supabase/pgvector. Returns a page-by-page classification report so the
// upload response can show it for review.
export async function ingestCarrierDoc({ carrier, slotId, slotLabel, filename, buf }) {
  const anthropic = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });

  const { text: pages } = await extractText(new Uint8Array(buf), { mergePages: false });
  const types = await classifyPages(anthropic, pages);
  const report = pages.map((_, i) => ({ page: i + 1, type: types[i] }));

  const tablePageNumbers = types.map((t, i) => (t === "table" ? i + 1 : null)).filter(Boolean);
  const narrativePageNumbers = types.map((t, i) => (t === "narrative" ? i + 1 : null)).filter(Boolean);

  // Table-heavy content: native PDF, stored under the same carrier_slotId key
  // chat.mjs already looks up -- sliced to just the table pages if the
  // document is mixed, or the full original if every page is table-heavy.
  const carrierStore = getStore({ name: "carrier-docs", consistency: "strong" });
  const key = `${carrier}_${slotId}`;
  if (tablePageNumbers.length === pages.length) {
    await carrierStore.set(key, buf, { metadata: { carrier, slotId, uploadedAt: new Date().toISOString() } });
  } else if (tablePageNumbers.length > 0) {
    // pdf-lib's page-copying occasionally chokes on a document's internal
    // structure (seen live: "Expected instance of PDFDict, but got instance
    // of undefined") independent of anything about the content itself. Fall
    // back to storing the full original PDF rather than losing the table
    // pages entirely -- worse than a precise slice (a few extra narrative
    // pages ride along in the native block) but far better than failing.
    try {
      const sliced = await extractTablePdf(buf, tablePageNumbers);
      await carrierStore.set(key, sliced, { metadata: { carrier, slotId, uploadedAt: new Date().toISOString(), slicedPages: tablePageNumbers.join(",") } });
    } catch {
      await carrierStore.set(key, buf, { metadata: { carrier, slotId, uploadedAt: new Date().toISOString(), sliceFailed: "true" } });
    }
  } else {
    // Purely narrative document -- no native block worth keeping. Remove any
    // stale entry from a prior upload so it stops being offered as a table doc.
    try { await carrierStore.delete(key); } catch { /* nothing to remove */ }
  }

  // Narrative content: chunk, embed, store in Supabase. Re-upload is
  // idempotent -- clear this slot's old chunks first. Degrades quietly if
  // Supabase/OpenAI aren't configured yet -- the table-PDF half above has
  // already succeeded regardless, and narrative search for this document
  // just isn't live until this step can run successfully.
  const chunkRows = [];
  for (const pageNum of narrativePageNumbers) {
    for (const content of chunkPage(pages[pageNum - 1])) {
      chunkRows.push({ carrier, slot_id: slotId, slot_label: slotLabel, source_filename: filename || null, page_number: pageNum, content });
    }
  }

  let chunksStored = 0;
  let narrativeError = null;
  try {
    const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));
    await supabase.rpc("delete_guideline_chunks", { match_carrier: carrier, match_slot_id: slotId });
    if (chunkRows.length > 0) {
      const openai = new OpenAI({ apiKey: Netlify.env.get("OPENAI_API_KEY") });
      const embeddings = await embedBatch(openai, chunkRows.map((r) => r.content));
      const rows = chunkRows.map((r, i) => ({ ...r, embedding: embeddings[i] }));
      const { error } = await supabase.from("guideline_chunks").insert(rows);
      if (error) throw new Error(error.message);
      chunksStored = rows.length;
    }

    // Ingestion-status record: the source of truth the verification script
    // reads to tell "this slot legitimately has zero narrative chunks
    // because it's 100% table" apart from "this slot silently failed to
    // index." Recorded even when narrativeError below ends up set, so a
    // failure is visible rather than just absent.
    await supabase.from("ingestion_status").upsert({
      carrier, slot_id: slotId, slot_label: slotLabel, source_filename: filename || null,
      table_page_count: tablePageNumbers.length, narrative_page_count: narrativePageNumbers.length,
      chunk_count: chunksStored, narrative_error: null, ingested_at: new Date().toISOString(),
    }, { onConflict: "carrier,slot_id" });
  } catch (err) {
    narrativeError = err.message;
    try {
      const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_KEY"));
      await supabase.from("ingestion_status").upsert({
        carrier, slot_id: slotId, slot_label: slotLabel, source_filename: filename || null,
        table_page_count: tablePageNumbers.length, narrative_page_count: narrativePageNumbers.length,
        chunk_count: chunksStored, narrative_error: narrativeError, ingested_at: new Date().toISOString(),
      }, { onConflict: "carrier,slot_id" });
    } catch { /* if even the status write fails, the upload response's narrativeError still surfaces it */ }
  }

  return {
    report,
    tablePageCount: tablePageNumbers.length,
    narrativePageCount: narrativePageNumbers.length,
    chunkCount: chunksStored,
    narrativeError,
  };
}
