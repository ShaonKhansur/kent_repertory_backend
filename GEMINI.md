# Project Context: Kent's Homeopathic Repertory RAG & Clinical Assistant

## 1. Project Goal

We are building a local, offline-capable Retrieval-Augmented Generation (RAG) and clinical repertorization system for **J.T. Kent's Repertory** so doctors can:

1. Search symptoms using natural clinical language or exact Kentian terms.
2. Receive matched rubrics with exact **Page Numbers (`page`)**, **Author (`J.T. Kent`)**, **Source URLs**, and **Graded Remedies (`grade`: 3, 2, 1)**.
3. Narrow down cases through **Clarifying Questions** derived from immediate child sub-rubrics (`depth + 1`) in Kent's hierarchy.
4. View a **Deterministic Repertorization Matrix** calculated via exact math (never let the LLM guess remedy scores).

## 2. Existing Workspace Data (Already Scraped & Parsed)

Do NOT re-scrape `homeoint.org`. The full book (285 HTML files, 1,423 pages) is already cached and parsed locally:

- Raw HTML Cache: `./kent_raw_html/`
- Master Remedy Dictionary (650+ remedies): `./kent_output/kent_remedies_master.json`
- Complete Structured Repertory (JSONL): `./kent_output/kent_repertory_full.jsonl`

### JSONL Record Schema (`kent_repertory_full.jsonl`)

Each line is a complete, atomic rubric:

- `id`: String (e.g., `"kent_mind_000005"`)
- `book`: `"Kent's Repertory"`
- `author`: `"J.T. Kent"`
- `chapter`: String (e.g., `"Mind"`, `"Vertigo"`, `"Head"`)
- `page`: Number (1 to 1423)
- `source_url`: String (e.g., `"http://homeoint.org/books/kentrep/kent0000.htm#P1"`)
- `depth`: Number (0 = main rubric, 1 = sub-rubric, 2 = sub-sub-rubric)
- `rubric_label`: String (leaf label, e.g., `"evening"`)
- `rubric_path`: String (full hierarchy, e.g., `"Mind > ABANDONED > evening"`)
- `embedding_text`: String
- `cross_references`: Array of Strings
- `remedy_count`: Number
- `remedies`: Array of `{ "abbr": "Puls.", "full_name": "Pulsatilla Nigricans", "grade": 3 }`

## 3. Tech Stack & RAG Architecture Constraints (STRICT RULES)

1. **Local AI Stack (No Paid API Keys):**
   - Use **LangChain.js** (`langchain`, `@langchain/core`, `@langchain/ollama`) with local **Ollama** (`http://localhost:11434`).
   - Embedding Model: `nomic-embed-text` via `OllamaEmbeddings`.
   - Chat Model: `llama3.2` (or `qwen2.5`) via `ChatOllama`.
2. **NO Text Splitters (`RecursiveCharacterTextSplitter` is BANNED):**
   - Each line in `./kent_output/kent_repertory_full.jsonl` is ALREADY 1 atomic rubric chunk.
   - Map each JSONL line directly to a `new Document({ pageContent, metadata })`.
   - Never embed the `remedies` array into the vector `pageContent` (keep `remedies`, `page`, `author`, and `depth` inside `metadata`).
3. **Child Sub-Rubric Questioning:**
   - When a rubric is matched at `depth: d`, inspect child rubrics in `kent_repertory_full.jsonl` that start with `parent.rubric_path + " > "` at `depth: d + 1`.
   - Pass those child labels to the LLM so it can ask the doctor 2–3 clarifying questions (modalities, time, location) to narrow down the case.
4. **Deterministic Repertorization Math:**
   - Always calculate remedy rankings in JavaScript/TypeScript code by summing `grade` (3, 2, 1) and counting `rubrics_covered` across selected rubrics.
