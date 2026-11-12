# B1 spike results (2026-11-12)

**Corpus:** 168 passages from this repo: section chunks of `functions/*.md`, plus the description and intro of every library agent (15) and skill (48).

**Queries:** 50 (`queries.ts`):
- 40 paraphrases written to avoid the passages' own words;
- 10 keyword-style queries.

**Metrics:**
- **recall@5:** the share of relevant passages in the top 5.
- **MRR@10:** the reciprocal rank of the first relevant passage.

**Runtime:** onnxruntime-web 1.31.1 (WASM, single thread, `ort-wasm-simd-threaded.wasm`) in Node 24 on Windows; int8-quantized ONNX models.

## Run 1: both models (batch 16, sorted by length)

| Ranker | recall@5 (all) | MRR@10 (all) | recall@5 (paraphrase) | MRR@10 (paraphrase) | recall@5 (keyword) | MRR@10 (keyword) |
|---|---|---|---|---|---|---|
| FTS5 keyword (all words, today's Brain search) | 0.187 | 0.200 | 0.000 | 0.000 | 0.933 | 1.000 |
| FTS5 keyword (any word, stop words dropped) | 0.580 | 0.545 | 0.475 | 0.432 | 1.000 | 1.000 |
| bge-small-en-v1.5 vectors | 0.623 | 0.617 | 0.542 | 0.521 | 0.947 | 1.000 |
| Hybrid FTS5 (any word) + bge-small | 0.617 | 0.635 | 0.529 | 0.543 | 0.967 | 1.000 |
| all-MiniLM-L6-v2 vectors | 0.640 | 0.686 | 0.567 | 0.607 | 0.933 | 1.000 |
| **Hybrid FTS5 (any word) + MiniLM** | **0.663** | **0.687** | **0.579** | **0.608** | **1.000** | **1.000** |

| Model | Load | ms per passage | ms per query | RSS Δ |
|---|---|---|---|---|
| bge-small-en-v1.5 (34 MB) | 323 ms | 231 | 14.6 | +560 MB |
| all-MiniLM-L6-v2 (23 MB) | 60 ms | 80 | 5.1 | +37 MB |

**Winner: all-MiniLM-L6-v2 with hybrid "any word" FTS5.** It has the best overall quality and keeps keyword queries perfect. It is also about 3× faster and uses about 15× less memory than bge-small, and is a smaller download. The bge-small files were deleted after this run.

## Run 2: MiniLM, batch size 1 (the shipped default)

Batch size 1 is the default because the dynamic int8 quantization makes a text's vector depend on its batch neighbours (cosine about 0.97 between the same text alone and batched). One text per run makes every vector depend only on its own text. It is also faster, because there is no padding.

| Ranker | recall@5 (all) | MRR@10 (all) | recall@5 (paraphrase) | MRR@10 (paraphrase) | recall@5 (keyword) | MRR@10 (keyword) |
|---|---|---|---|---|---|---|
| FTS5 keyword (all words) | 0.187 | 0.200 | 0.000 | 0.000 | 0.933 | 1.000 |
| FTS5 keyword (any word) | 0.580 | 0.545 | 0.475 | 0.432 | 1.000 | 1.000 |
| all-MiniLM-L6-v2 vectors | 0.647 | 0.669 | 0.575 | 0.587 | 0.933 | 1.000 |
| Hybrid FTS5 (any word) + MiniLM | 0.633 | 0.674 | 0.542 | 0.593 | 1.000 | 1.000 |

MiniLM at batch 1: load 260 ms, **65 ms per passage**, 5.1 ms per query.

## Takeaways for the integration

- **Today's Brain search finds nothing for natural sentences.** It requires every word to match (implicit AND). The keyword half of hybrid search must OR the meaningful words, with stop words dropped, so bm25 can rank partial matches.
- **Meaning search is the big gain:** paraphrase recall@5 goes from 0 (today) to about 0.55–0.58. Hybrid keeps keyword queries perfect.
- **Noise:** with 50 queries, differences of about ±0.03 between the vector and hybrid rows are within noise. Hybrid is chosen for its keyword robustness, not for a measured paraphrase gain.
- **Embedding cost:** about 65 ms per record on one thread, so a 10,000-record Brain takes about 11 minutes once, in the background. Queries take about 5 ms.
