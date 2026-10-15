import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';

// The 4 directories used by homeoint.org across the 1,423 pages
const BASE_DIRS = [
  'http://homeoint.org/books/kentrep/',
  'http://homeoint.org/books/kentrep1/',
  'http://homeoint.org/books/kentrep2/',
  'http://homeoint.org/books/kentrep3/',
];

const REMEDIES_URL = 'http://homeoint.org/books/kentrep/kentreme.htm';
const CACHE_DIR = 'kent_raw_html';
const OUTPUT_DIR = 'kent_output';

const KENT_CHAPTER_HEADERS = {
  'MIND': 'Mind',
  'VERTIGO': 'Vertigo',
  'HEAD': 'Head',
  'EYE': 'Eye',
  'VISION': 'Vision',
  'EAR': 'Ear',
  'HEARING': 'Hearing',
  'NOSE': 'Nose',
  'FACE': 'Face',
  'MOUTH': 'Mouth',
  'TEETH': 'Teeth',
  'THROAT': 'Throat',
  'EXTERNAL THROAT': 'External Throat',
  'STOMACH': 'Stomach',
  'ABDOMEN': 'Abdomen',
  'RECTUM': 'Rectum',
  'STOOL': 'Stool',
  'URINARY ORGANS': 'Urinary Organs',
  'BLADDER': 'Bladder',
  'KIDNEYS': 'Kidneys',
  'PROSTATE GLAND': 'Prostate Gland',
  'URETHRA': 'Urethra',
  'URINE': 'Urine',
  'GENITALIA MALE': 'Genitalia Male',
  'GENITALIA, MALE': 'Genitalia Male',
  'GENITALIA FEMALE': 'Genitalia Female',
  'GENITALIA, FEMALE': 'Genitalia Female',
  'LARYNX AND TRACHEA': 'Larynx and Trachea',
  'RESPIRATION': 'Respiration',
  'COUGH': 'Cough',
  'EXPECTORATION': 'Expectoration',
  'CHEST': 'Chest',
  'BACK': 'Back',
  'EXTREMITIES': 'Extremities',
  'SLEEP': 'Sleep',
  'CHILL': 'Chill',
  'FEVER': 'Fever',
  'PERSPIRATION': 'Perspiration',
  'SKIN': 'Skin',
  'GENERALITIES': 'Generalities',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tracks which of the 4 folders (kentrep, kentrep1, kentrep2, kentrep3) we are currently in
let activeDirIndex = 0;

function normalizeRemedyKey(abbr) {
  return abbr
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe');
}

async function fetchFileFromMultiDirs(localFilename) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const filepath = path.join(CACHE_DIR, localFilename);

  // Read from cache if already downloaded!
  if (fs.existsSync(filepath)) {
    const cachedHtml = fs.readFileSync(filepath, 'utf-8');
    // Estimate folder URL for source_url metadata
    const fileNum = parseInt(localFilename.replace(/\D/g, ''), 10) || 0;
    const folder =
      fileNum <= 300 ? BASE_DIRS[0] : fileNum <= 600 ? BASE_DIRS[1] : fileNum <= 1100 ? BASE_DIRS[2] : BASE_DIRS[3];
    return { html: cachedHtml, finalUrl: `${folder}${localFilename}` };
  }

  // Try starting from the currently active directory index
  for (let offset = 0; offset < BASE_DIRS.length; offset++) {
    const dirIdx = (activeDirIndex + offset) % BASE_DIRS.length;
    const candidateUrl = `${BASE_DIRS[dirIdx]}${localFilename}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await axios.get(candidateUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Kent-RAG-Parser/1.0)' },
        });
        const decodedHtml = iconv.decode(Buffer.from(response.data), 'iso-8859-1');
        fs.writeFileSync(filepath, decodedHtml, 'utf-8');
        activeDirIndex = dirIdx; // Lock onto this folder for subsequent files
        console.log(`Downloaded ${candidateUrl}`);
        await sleep(300);
        return { html: decodedHtml, finalUrl: candidateUrl };
      } catch (err) {
        if (err.response && err.response.status === 404) {
          break; // 404 in this folder -> immediately try next folder (kentrep1, kentrep2, etc.)
        }
        console.warn(`Retry ${attempt}/2 for ${candidateUrl}: ${err.message}`);
        await sleep(1500);
      }
    }
  }

  console.error(`Could not find ${localFilename} in any of the 4 kentrep directories.`);
  return { html: '', finalUrl: '' };
}

async function buildRemedyDictionary() {
  const filepath = path.join(CACHE_DIR, 'kentreme.htm');
  let html = '';
  if (fs.existsSync(filepath)) {
    html = fs.readFileSync(filepath, 'utf-8');
  } else {
    const response = await axios.get(REMEDIES_URL, { responseType: 'arraybuffer' });
    html = iconv.decode(Buffer.from(response.data), 'iso-8859-1');
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(filepath, html, 'utf-8');
  }

  const $ = cheerio.load(html);
  const textContent = $('body').text();

  const pattern = /^([A-Za-zÆŒæœ\-]+)\.?\s*-{3,}\s*(.+)$/;
  const remedyLookup = {};
  const masterList = [];

  for (const rawLine of textContent.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    const match = line.match(pattern);
    if (match) {
      const canonicalAbbr = `${match[1].trim()}.`;
      const cleanFullName = match[2].trim();
      const entry = { abbr: canonicalAbbr, full_name: cleanFullName };

      remedyLookup[normalizeRemedyKey(canonicalAbbr)] = entry;
      remedyLookup[canonicalAbbr.toLowerCase().replace(/\.+$/, '')] = entry;
      masterList.push(entry);
    }
  }
  return { remedyLookup, masterList };
}

class FullKentBookParser {
  constructor(remedyLookup) {
    this.remedyLookup = remedyLookup;
    this.currentPage = 1;
    this.currentChapter = 'Mind';
    this.hierarchyStack = {};
    this.records = [];
    this.rubricCounter = 0;
  }

  getNestingDepth($, pElem) {
    let depth = 0;
    let parent = $(pElem).parent();
    while (parent.length && parent[0].tagName !== 'body') {
      const tag = parent[0].tagName?.toLowerCase();
      if (['dir', 'blockquote', 'ul', 'dl'].includes(tag)) {
        depth++;
      }
      parent = parent.parent();
    }
    return depth;
  }

  extractCrossReferences(rubricPart) {
    const crossRefs = [];
    const pattern = /\(\s*[Ss]ee\s+([^)]+)\)/g;
    let match;
    while ((match = pattern.exec(rubricPart)) !== null) {
      const refs = match[1]
        .split(/,|\balso\b/)
        .map((r) => r.trim())
        .filter(Boolean);
      crossRefs.push(...refs);
    }
    const cleaned = rubricPart
      .replace(pattern, '')
      .replace(/[\s:.]+$/, '')
      .trim();
    return { cleanRubric: cleaned, crossRefs };
  }

  parseRemediesFromNodes($, nodes) {
    const remedies = [];

    const walkNode = (node, isBold = false, isItalic = false, isRed = false) => {
      if (node.type === 'text') {
        const tokens = node.data.split(',').map((t) => t.replace(/^[ .,;\n\r\t]+|[ .,;\n\r\t]+$/g, ''));
        for (const token of tokens) {
          if (token && /^[A-Za-zÆŒæœ][a-zA-ZÆŒæœ\-]+$/.test(token)) {
            const grade = isBold || isRed ? 3 : isItalic ? 2 : 1;
            const lookupKey = normalizeRemedyKey(token);
            const matched = this.remedyLookup[lookupKey];

            const normAbbr = matched
              ? matched.abbr
              : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase() + '.';
            const fullName = matched ? matched.full_name : null;

            remedies.push({ abbr: normAbbr, full_name: fullName, grade });
          }
        }
      } else if (node.type === 'tag') {
        const tag = node.tagName.toLowerCase();
        const newBold = isBold || tag === 'b' || tag === 'strong';
        const newItalic = isItalic || tag === 'i' || tag === 'em';
        const colorAttr = ($(node).attr('color') || '').toLowerCase();
        const newRed = isRed || (tag === 'font' && colorAttr.includes('#ff0000'));

        for (const child of node.children || []) {
          walkNode(child, newBold, newItalic, newRed);
        }
      }
    };

    for (const n of nodes) {
      walkNode(n);
    }
    return remedies;
  }

  splitRubricAndRemedies($, pElem) {
    const rubricParts = [];
    const remedyNodes = [];
    let foundColon = false;

    for (const child of pElem.children || []) {
      if (!foundColon) {
        const textVal = child.type === 'text' ? child.data : $(child).text();
        const colonIdx = textVal.indexOf(':');
        if (colonIdx !== -1) {
          foundColon = true;
          const left = textVal.slice(0, colonIdx);
          const right = textVal.slice(colonIdx + 1);
          rubricParts.push(left);
          if (right.trim()) {
            remedyNodes.push({ type: 'text', data: right });
          }
        } else {
          rubricParts.push(textVal);
        }
      } else {
        remedyNodes.push(child);
      }
    }

    const rawRubric = rubricParts.join('').replace(/\s+/g, ' ').trim();
    return { rawRubric, remedyNodes };
  }

  parseHtmlFile(htmlContent, fileUrl) {
    const $ = cheerio.load(htmlContent);
    const body = $('body');
    if (!body.length) return;

    body.find('p').each((_, pElem) => {
      // 1. Check for <a name="P123"> page anchors inside this <p>
      $(pElem)
        .find('a[name]')
        .each((__, aElem) => {
          const nameAttr = $(aElem).attr('name') || '';
          const anchorMatch = nameAttr.match(/^P(\d+)$/i);
          if (anchorMatch) {
            this.currentPage = parseInt(anchorMatch[1], 10);
          }
        });

      const fullText = $(pElem).text().replace(/\s+/g, ' ').trim();
      if (!fullText) return;

      // 2. Also check for inline "p. 123" page markers (e.g., "---------- MIND p. 5 ----------")
      const inlinePageMatch = fullText.match(/\bp\.\s*(\d+)\b/i);
      if (inlinePageMatch && (fullText.startsWith('p.') || fullText.includes('---'))) {
        this.currentPage = parseInt(inlinePageMatch[1], 10);
        return;
      }

      // 3. Detect Chapter Transitions
      const headerCandidate = fullText.toUpperCase().replace(/[ .:]+$/, '');
      if (KENT_CHAPTER_HEADERS[headerCandidate] && !fullText.includes(':')) {
        const newChapter = KENT_CHAPTER_HEADERS[headerCandidate];
        if (newChapter !== this.currentChapter) {
          console.log(`  --> Switching chapter: ${this.currentChapter} -> ${newChapter} (Page ${this.currentPage})`);
          this.currentChapter = newChapter;
          this.hierarchyStack = {};
        }
        return;
      }

      // 4. Skip headers/footers/dividers
      if (
        fullText.includes('KENT') ||
        fullText.includes('Copyright') ||
        fullText.includes('MEDI-T') ||
        fullText.startsWith('---') ||
        /^[\-\s.]+$/.test(fullText)
      ) {
        return;
      }

      // 5. Parse rubric & remedies
      const depth = this.getNestingDepth($, pElem);
      const { rawRubric, remedyNodes } = this.splitRubricAndRemedies($, pElem);
      const { cleanRubric, crossRefs } = this.extractCrossReferences(rawRubric);

      if (!cleanRubric) return;

      this.hierarchyStack[depth] = cleanRubric;
      for (const k of Object.keys(this.hierarchyStack)) {
        if (Number(k) > depth) delete this.hierarchyStack[k];
      }

      const orderedPath = Object.keys(this.hierarchyStack)
        .map(Number)
        .sort((a, b) => a - b)
        .map((k) => this.hierarchyStack[k]);

      const fullRubricPath = `${this.currentChapter} > ${orderedPath.join(' > ')}`;
      const remedies = this.parseRemediesFromNodes($, remedyNodes);

      if (remedies.length === 0 && crossRefs.length === 0) return;

      this.rubricCounter++;
      const chapterSlug = this.currentChapter.toLowerCase().replace(/[\s,]+/g, '_');

      this.records.push({
        id: `kent_${chapterSlug}_${String(this.rubricCounter).padStart(6, '0')}`,
        book: "Kent's Repertory",
        author: 'J.T. Kent',
        chapter: this.currentChapter,
        page: this.currentPage,
        source_url: `${fileUrl}#P${this.currentPage}`,
        depth,
        rubric_label: cleanRubric,
        rubric_path: fullRubricPath,
        embedding_text: `Kent Repertory | Chapter: ${this.currentChapter} | Symptom Rubric: ${fullRubricPath}`,
        cross_references: crossRefs,
        remedy_count: remedies.length,
        remedies,
      });
    });
  }

  async runFullBookScrape(startFile = 0, endFile = 1420) {
    const totalFiles = Math.floor((endFile - startFile) / 5) + 1;
    let processed = 0;

    for (let fileNum = startFile; fileNum <= endFile; fileNum += 5) {
      processed++;
      const filename = `kent${String(fileNum).padStart(4, '0')}.htm`;

      const { html, finalUrl } = await fetchFileFromMultiDirs(filename);
      if (html) {
        this.parseHtmlFile(html, finalUrl);
      }

      if (processed % 20 === 0 || fileNum === endFile) {
        console.log(
          `[${processed}/${totalFiles} files] Parsed up to ${filename} | Page: ${this.currentPage} | Total Rubrics: ${this.records.length.toLocaleString()}`
        );
      }
    }
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { remedyLookup, masterList } = await buildRemedyDictionary();
  const remediesPath = path.join(OUTPUT_DIR, 'kent_remedies_master.json');
  fs.writeFileSync(remediesPath, JSON.stringify(masterList, null, 2), 'utf-8');
  console.log(`Saved ${masterList.length} remedies to ${remediesPath}\n`);

  const parser = new FullKentBookParser(remedyLookup);
  await parser.runFullBookScrape(0, 1420);

  const jsonlPath = path.join(OUTPUT_DIR, 'kent_repertory_full.jsonl');
  const writeStream = fs.createWriteStream(jsonlPath, { encoding: 'utf-8' });
  for (const rec of parser.records) {
    writeStream.write(JSON.stringify(rec) + '\n');
  }
  writeStream.end();

  const jsonPath = path.join(OUTPUT_DIR, 'kent_repertory_full.json');
  fs.writeFileSync(jsonPath, JSON.stringify(parser.records, null, 2), 'utf-8');

  console.log(`\nCompleted! Extracted ${parser.records.length.toLocaleString()} total rubrics.`);
  console.log(`JSONL for RAG ingestion: ${jsonlPath}`);
}

main();