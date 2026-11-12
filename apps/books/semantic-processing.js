export const PROCESSING_SCHEMA_VERSION = 2;
export const PROCESSING_PIPELINE_VERSION = 'library-intelligence-v2';
export const PASSAGE_EXTRACTOR_VERSION = 'passages-v5';
export const LEXICAL_INDEX_VERSION = 'lexical-v1';
export const DETERMINISTIC_SEMANTICS_VERSION = 'deterministic-semantics-v2';
export const IDEA_EMBEDDING_INDEX_VERSION = 'idea-embeddings-v2';
export const LIBRARY_IDEA_LINK_VERSION = 'library-idea-links-v1';
export const DEFAULT_MAX_PASSAGE_CHARS = 1400;
export const DEFAULT_MAX_CONCEPTS = 16;
export const DEFAULT_MAX_SCENES = 12;
export const DEFAULT_MAX_CONCEPT_EVIDENCE = 4;

const DEFAULT_PROCESSING_STAGES = {
  fingerprint: { status:'pending' },
  passages: { status:'pending' },
  lexicalIndex: { status:'pending' },
  deterministicSemantics: { status:'pending' },
  modelSemantics: { status:'waiting-for-provider' },
  semanticUnits: { status:'pending' },
  embeddings: { status:'waiting-for-model' },
  libraryLinks: { status:'blocked-by-embeddings' },
  echoEmbeddings: { status:'waiting-for-model' },
  echoLinks: { status:'blocked-by-embeddings' },
};

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'among', 'because', 'been',
  'before', 'being', 'between', 'both', 'could', 'does', 'doing', 'down',
  'during', 'each', 'from', 'further', 'have', 'having', 'here', 'into',
  'itself', 'more', 'most', 'other', 'over', 'same', 'should', 'some',
  'such', 'than', 'that', 'their', 'theirs', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very',
  'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your',
  'book', 'books', 'chapter', 'chapters', 'electronic', 'said', 'says',
  'work', 'works',
]);

const BOILERPLATE_PATTERNS = [
  /project gutenberg/i,
  /gutenberg (?:ebook|license)/i,
  /www\.gutenberg\.org/i,
  /produced by .*distributed proofreading/i,
  /this ebook is for the use of anyone anywhere/i,
  /you may copy it, give it away or re-use it/i,
  /full project gutenberg license/i,
  /end of (?:the )?project gutenberg/i,
];

export function isLikelyBoilerplatePassage(passage) {
  const text = String(passage?.text || '');
  const label = String(passage?.structure?.label || '');
  return BOILERPLATE_PATTERNS.some((pattern) => (
    pattern.test(text) || pattern.test(label)
  ));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizePassageText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function tokenize(value) {
  const normalized = normalizePassageText(value).toLocaleLowerCase();
  return normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'sha256:' + Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

// Fragment an over-long paragraph by a UTF-16 code-unit budget without ever
// splitting a surrogate pair, so the browser and native (Python) executors
// produce identical fragment boundaries and counts for non-BMP text (M16).
// Mirrors split_utf16_fragments in scripts/books-index.py exactly.
function splitUtf16Fragments(value, maxUnits) {
  const fragments = [];
  let current = '';
  let units = 0;
  for (const character of value) {
    const width = character.length;
    if (current && units + width > maxUnits) {
      fragments.push(current);
      current = '';
      units = 0;
    }
    current += character;
    units += width;
  }
  if (current) fragments.push(current);
  return fragments;
}

function splitSection(text, maxChars) {
  const normalized = normalizePassageText(text);
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks = [];
  let chunk = '';
  let chunkParagraphs = [];
  let sourceStart = 0;
  let cursor = 0;

  const pushChunk = () => {
    const value = chunk.trim();
    if (!value) return;
    chunks.push({
      text: value,
      start: sourceStart,
      end: sourceStart + value.length,
      paragraphs:chunkParagraphs,
    });
    chunk = '';
    chunkParagraphs = [];
  };

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex];
    const trimmed = paragraph.trim();
    const paragraphStart = normalized.indexOf(trimmed, cursor);
    cursor = Math.max(cursor, paragraphStart + trimmed.length);
    if (!trimmed) continue;
    if (trimmed.length > maxChars) {
      pushChunk();
      const fragments = splitUtf16Fragments(trimmed, maxChars);
      const fragmentCount = fragments.length;
      let utf16Offset = 0;
      for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
        const text = fragments[fragmentIndex];
        const end = utf16Offset + text.length;
        chunks.push({
          text,
          start: paragraphStart + utf16Offset,
          end: paragraphStart + end,
          paragraphs:[{
            text,
            start:paragraphStart + utf16Offset,
            end:paragraphStart + end,
            paragraphIndex,
            fragmentIndex,
            fragmentCount,
          }],
        });
        utf16Offset = end;
      }
      continue;
    }
    if (chunk && chunk.length + 2 + trimmed.length > maxChars) pushChunk();
    if (!chunk) sourceStart = paragraphStart;
    chunk += (chunk ? '\n\n' : '') + trimmed;
    chunkParagraphs.push({
      text:trimmed,
      start:paragraphStart,
      end:paragraphStart + trimmed.length,
      paragraphIndex,
      fragmentIndex:0,
      fragmentCount:1,
    });
  }
  pushChunk();
  return chunks;
}

export async function segmentSections({
  workId,
  assetId,
  format,
  sections = [],
  maxChars = DEFAULT_MAX_PASSAGE_CHARS,
}) {
  const passages = [];
  let paragraphOrder = 0;
  // Occurrence disambiguation is whole-asset, not per-section, so paragraph IDs
  // can drop the positional section index and stay content-addressed (M3).
  const paragraphHashOccurrences = new Map();
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const section = sections[sectionIndex] || {};
    const normalized = normalizePassageText(section.text);
    const chunks = splitSection(normalized, maxChars);
    for (const chunk of chunks) {
      const quote = chunk.text.slice(0, 240);
      const passageId = [
        'passage',
        assetId,
        sectionIndex,
        chunk.start,
        chunk.end,
      ].join('_');
      const paragraphs = [];
      for (const sourceParagraph of chunk.paragraphs || []) {
        const paragraphQuote = sourceParagraph.text.slice(0, 240);
        const paragraphTextHash = await sha256Text(sourceParagraph.text);
        const hashToken = paragraphTextHash.slice('sha256:'.length, 'sha256:'.length + 16);
        const occurrence = paragraphHashOccurrences.get(hashToken) || 0;
        paragraphHashOccurrences.set(hashToken, occurrence + 1);
        const paragraphId = [
          'paragraph',
          assetId,
          hashToken,
          occurrence,
        ].join('_');
        paragraphs.push({
          paragraphId,
          passageId,
          workId,
          assetId,
          extractorVersion:PASSAGE_EXTRACTOR_VERSION,
          order:paragraphOrder++,
          passageOrder:passages.length,
          text:sourceParagraph.text,
          structure:{
            sectionIndex,
            label:section.label || null,
            paragraphIndex:sourceParagraph.paragraphIndex,
            fragmentIndex:sourceParagraph.fragmentIndex,
            fragmentCount:sourceParagraph.fragmentCount,
          },
          anchor:{
            format,
            normalizedRange:{
              start:sourceParagraph.start,
              end:sourceParagraph.end,
            },
            quote:paragraphQuote,
            quoteHash:await sha256Text(paragraphQuote),
            textHash:paragraphTextHash,
            engine:{
              ...(cloneJson(section.anchor || {})),
              fraction:normalized.length
                ? sourceParagraph.start / normalized.length : 0,
            },
          },
        });
      }
      passages.push({
        passageId,
        workId,
        assetId,
        extractorVersion: PASSAGE_EXTRACTOR_VERSION,
        order: passages.length,
        text: chunk.text,
        paragraphs,
        structure: {
          sectionIndex,
          label: section.label || null,
          unsupportedStructures:Array.from(new Set(
            (section.unsupportedStructures || [])
              .map((value) => String(value || '').trim())
              .filter(Boolean),
          )).sort(),
        },
        anchor: {
          format,
          normalizedRange: {
            start: chunk.start,
            end: chunk.end,
          },
          quote,
          quoteHash: await sha256Text(quote),
          engine: {
            ...(cloneJson(section.anchor || {})),
            fraction: normalized.length ? chunk.start / normalized.length : 0,
          },
        },
      });
    }
  }
  return passages;
}

export function buildLexicalIndex({ workId, title = '', authors = [], passages = [] }) {
  const postings = {};
  const termFrequency = {};
  const add = (term, passageIndex, weight = 1) => {
    if (!postings[term]) postings[term] = [];
    const last = postings[term][postings[term].length - 1];
    if (last !== passageIndex) postings[term].push(passageIndex);
    termFrequency[term] = (termFrequency[term] || 0) + weight;
  };

  const metadataText = [title]
    .concat(authors.map((author) => author?.name || author || ''))
    .join(' ');
  for (const term of tokenize(metadataText)) add(term, -1, 3);
  passages.forEach((passage, passageIndex) => {
    for (const term of tokenize(passage.text)) add(term, passageIndex, 1);
  });

  const sortedPostings = {};
  for (const term of Object.keys(postings).sort()) sortedPostings[term] = postings[term];
  return {
    schemaVersion: PROCESSING_SCHEMA_VERSION,
    recordType: 'books.lexical-index',
    indexVersion: LEXICAL_INDEX_VERSION,
    workId,
    passageIds: passages.map((passage) => passage.passageId),
    postings: sortedPostings,
    termFrequency,
  };
}

export function searchLexicalIndex(index, query) {
  const terms = Array.from(new Set(tokenize(query)));
  if (!terms.length || !index?.postings) return [];
  const scores = new Map();
  for (const term of terms) {
    for (const passageIndex of index.postings[term] || []) {
      if (passageIndex < 0) continue;
      scores.set(passageIndex, (scores.get(passageIndex) || 0) + 1);
    }
  }
  return Array.from(scores, ([passageIndex, score]) => ({
    passageIndex,
    passageId: index.passageIds[passageIndex],
    score: score / terms.length,
  })).sort((left, right) =>
    right.score - left.score || left.passageIndex - right.passageIndex);
}

export function extractDeterministicSemantics({
  workId,
  passages,
  lexicalIndex,
  maxConcepts = DEFAULT_MAX_CONCEPTS,
  maxScenes = DEFAULT_MAX_SCENES,
}) {
  const bodyPassageIndexes = new Set(passages.flatMap((passage, index) =>
    isLikelyBoilerplatePassage(passage) ? [] : [index]));
  const candidates = Object.entries(lexicalIndex.termFrequency || {})
    .filter(([term]) => (
      term.length >= 4
      && !STOP_WORDS.has(term)
      && !/^\p{N}+$/u.test(term)
    ))
    .map(([term, frequency]) => {
      const passageIndexes = (lexicalIndex.postings[term] || [])
        .filter((index) => bodyPassageIndexes.has(index));
      return {
        term,
        frequency,
        spread: passageIndexes.length,
        passageIndexes,
        score: frequency * (1 + Math.log2(1 + passageIndexes.length)),
      };
    })
    .filter((candidate) => candidate.passageIndexes.length > 0)
    .sort((left, right) =>
      right.score - left.score || left.term.localeCompare(right.term))
    .slice(0, maxConcepts);

  const concepts = candidates.map((candidate) => ({
    conceptId: 'concept_' + workId + '_' + candidate.term.replace(/[^\p{L}\p{N}-]+/gu, '_'),
    workId,
    label: candidate.term,
    kind: 'candidate-topic',
    description: null,
    confidence: Math.min(0.85, 0.35 + Math.log10(1 + candidate.score) / 3),
    evidence: candidate.passageIndexes
      .slice(0, DEFAULT_MAX_CONCEPT_EVIDENCE)
      .map((index) => ({
      passageId: passages[index].passageId,
      quoteHash: passages[index].anchor.quoteHash,
      weight: 1,
      })),
    generatedBy: {
      extractor: DETERMINISTIC_SEMANTICS_VERSION,
      mode: 'deterministic-local',
    },
    userState: {
      hidden: false,
      labelOverride: null,
    },
  }));

  const sectionFirstPassages = new Map();
  for (const passage of passages) {
    if (isLikelyBoilerplatePassage(passage)) continue;
    const sectionIndex = passage.structure.sectionIndex;
    if (!sectionFirstPassages.has(sectionIndex)) {
      sectionFirstPassages.set(sectionIndex, passage);
    }
  }
  const scenes = Array.from(sectionFirstPassages.values())
    .slice(0, maxScenes)
    .map((passage, index) => ({
      sceneId: 'scene_' + workId + '_' + String(index + 1),
      workId,
      label: passage.structure.label || 'Section ' + (passage.structure.sectionIndex + 1),
      kind: 'section-opening',
      description: passage.text.slice(0, 320),
      evidence: [{
        passageId: passage.passageId,
        quoteHash: passage.anchor.quoteHash,
        weight: 1,
      }],
      generatedBy: {
        extractor: DETERMINISTIC_SEMANTICS_VERSION,
        mode: 'deterministic-local',
      },
      userState: {
        hidden: false,
        labelOverride: null,
      },
    }));

  return {
    schemaVersion: PROCESSING_SCHEMA_VERSION,
    recordType: 'books.semantic-records',
    extractorVersion: DETERMINISTIC_SEMANTICS_VERSION,
    workId,
    concepts,
    scenes,
  };
}

export function makeProcessingRun({
  workId,
  assetId,
  previous = null,
  priority = 'background',
  executorClass = null,
  now = () => new Date().toISOString(),
}) {
  const createdAt = previous?.createdAt || now();
  const stages = cloneJson(DEFAULT_PROCESSING_STAGES);
  for (const [stage, value] of Object.entries(previous?.stages || {})) {
    stages[stage] = cloneJson(value);
  }
  return {
    schemaVersion: PROCESSING_SCHEMA_VERSION,
    recordType: 'books.processing-run',
    pipelineVersion:PROCESSING_PIPELINE_VERSION,
    workId,
    assetId,
    priority:previous?.priority || priority,
    executorClass:previous?.executorClass || executorClass,
    sourceFingerprint:previous?.sourceFingerprint || null,
    lease:cloneJson(previous?.lease || null),
    cancelRequested:previous?.cancelRequested === true,
    checkpoint:cloneJson(previous?.checkpoint || null),
    artifacts:cloneJson(previous?.artifacts || {}),
    stages,
    createdAt,
    updatedAt: previous?.updatedAt || createdAt,
  };
}

export function processingLeaseActive(run, at = Date.now()) {
  const expiresAt = Date.parse(run?.lease?.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > Number(at);
}

export function claimProcessingRun(
  run,
  {
    executorId,
    executorClass = 'browser',
    leaseMs = 60_000,
  } = {},
  now = () => new Date().toISOString(),
) {
  if (!run || !executorId) return { run, claimed:false, reason:'invalid-claim' };
  const timestamp = now();
  const nowMs = Date.parse(timestamp);
  const active = processingLeaseActive(run, nowMs);
  if (active && run.lease.executorId !== executorId) {
    return { run, claimed:false, reason:'leased' };
  }
  const next = cloneJson(run);
  next.executorClass = executorClass;
  next.lease = {
    executorId:String(executorId),
    executorClass:String(executorClass),
    claimedAt:active && run.lease.executorId === executorId
      ? run.lease.claimedAt : timestamp,
    renewedAt:timestamp,
    expiresAt:new Date(nowMs + Math.max(5_000, Number(leaseMs) || 60_000))
      .toISOString(),
  };
  next.updatedAt = timestamp;
  return { run:next, claimed:true, reason:active ? 'renewed' : 'claimed' };
}

export function releaseProcessingRun(
  run,
  executorId,
  now = () => new Date().toISOString(),
) {
  if (!run?.lease || run.lease.executorId !== executorId) return run;
  const next = cloneJson(run);
  next.lease = null;
  next.updatedAt = now();
  return next;
}

export function requestProcessingCancellation(
  run,
  requested = true,
  now = () => new Date().toISOString(),
) {
  const next = cloneJson(run);
  next.cancelRequested = requested === true;
  next.updatedAt = now();
  return next;
}

export function updateProcessingCheckpoint(
  run,
  checkpoint,
  now = () => new Date().toISOString(),
) {
  const next = cloneJson(run);
  next.checkpoint = checkpoint ? cloneJson(checkpoint) : null;
  next.updatedAt = now();
  return next;
}

export function invalidateProcessingStages(
  run,
  stages,
  reason = 'input-changed',
  now = () => new Date().toISOString(),
) {
  const next = cloneJson(run);
  const resetStatus = {
    fingerprint:'pending',
    passages:'pending',
    lexicalIndex:'pending',
    deterministicSemantics:'pending',
    modelSemantics:'waiting-for-provider',
    semanticUnits:'pending',
    embeddings:'waiting-for-model',
    libraryLinks:'blocked-by-embeddings',
    echoEmbeddings:'waiting-for-model',
    echoLinks:'blocked-by-embeddings',
  };
  const timestamp = now();
  for (const stage of stages || []) {
    if (!(stage in resetStatus)) continue;
    const attempts = Number(next.stages?.[stage]?.attempts) || 0;
    next.stages[stage] = {
      status:resetStatus[stage],
      attempts,
      invalidatedReason:String(reason),
      updatedAt:timestamp,
    };
    if (next.artifacts) delete next.artifacts[stage];
  }
  if (next.checkpoint && (stages || []).includes(next.checkpoint.stage)) {
    next.checkpoint = null;
  }
  next.updatedAt = timestamp;
  return next;
}

export function updateProcessingStage(
  run,
  stage,
  status,
  details = {},
  now = () => new Date().toISOString(),
) {
  const next = cloneJson(run);
  const previous = next.stages[stage] || {};
  const attempts = status === 'running'
    ? (Number(previous.attempts) || 0) + 1
    : (Number(previous.attempts) || 0);
  next.stages[stage] = {
    ...previous,
    ...cloneJson(details),
    status,
    attempts,
    updatedAt: now(),
  };
  if (details?.artifact) {
    next.artifacts = {
      ...(next.artifacts || {}),
      [stage]:cloneJson(details.artifact),
    };
  }
  if (details?.sourceFingerprint) {
    next.sourceFingerprint = String(details.sourceFingerprint);
  }
  if (status === 'complete' && next.checkpoint?.stage === stage) {
    next.checkpoint = null;
  }
  next.updatedAt = next.stages[stage].updatedAt;
  return next;
}

export function passagesPath(workId) {
  return `semantic/${workId}/passages.json`;
}

export function semanticRecordsPath(workId) {
  return `semantic/${workId}/records.json`;
}

export function workLexicalIndexPath(workId) {
  return `indexes/works/${workId}.json`;
}

export function processingRunPath(workId) {
  return `jobs/${workId}.json`;
}
