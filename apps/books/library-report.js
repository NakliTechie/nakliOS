const CORE_STAGES = [
  'fingerprint',
  'passages',
  'lexicalIndex',
  'deterministicSemantics',
];

const FAILURE_STATUSES = new Set([
  'failed',
  'cancelled',
]);

const WAITING_STATUSES = new Set([
  'blocked',
  'blocked-by-embeddings',
  'pending',
  'queued',
  'waiting-for-model',
  'waiting-for-ocr',
  'waiting-for-provider',
  'waiting-for-stable-source',
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countBy(values, key) {
  const result = {};
  for (const value of values) {
    const name = typeof key === 'function' ? key(value) : value?.[key];
    const label = String(name || 'unknown');
    result[label] = (result[label] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stageStatus(run, name) {
  return String(run?.stages?.[name]?.status || 'missing');
}

export function processingOutcome(run) {
  if (!run) return 'not-queued';
  if (run.cancelRequested) return 'cancelled';
  const statuses = Object.values(run.stages || {})
    .map((stage) => String(stage?.status || 'pending'));
  if (statuses.some((status) => FAILURE_STATUSES.has(status))) return 'failed';
  if (statuses.includes('waiting-for-ocr')) return 'waiting-for-ocr';
  if (statuses.includes('waiting-for-stable-source')) {
    return 'waiting-for-stable-source';
  }
  if (statuses.includes('running')) return 'running';
  if (CORE_STAGES.every((stage) => stageStatus(run, stage) === 'complete')) {
    return 'core-complete';
  }
  if (statuses.some((status) => WAITING_STATUSES.has(status))) return 'queued';
  return 'incomplete';
}

export function buildLibraryReport({
  library = null,
  inventory = null,
  catalog = null,
  manifests = [],
  jobs = [],
  passages = [],
  semantics = [],
  ideas = [],
  graph = null,
  semanticUnits = [],
  echoGraph = null,
  readerConnections = [],
  echoQuality = null,
  artifactErrors = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const manifestById = new Map(
    asArray(manifests).map((record) => [record.workId, record]),
  );
  const jobById = new Map(asArray(jobs).map((record) => [record.workId, record]));
  const passageById = new Map(
    asArray(passages).map((record) => [record.workId, record]),
  );
  const semanticById = new Map(
    asArray(semantics).map((record) => [record.workId, record]),
  );
  const ideaById = new Map(asArray(ideas).map((record) => [record.workId, record]));
  const unitsById = new Map(
    asArray(semanticUnits).map((record) => [record.workId, record]),
  );
  const readerConnectionsById = new Map(
    asArray(readerConnections).map((record) => [record.workId, record]),
  );
  // Paragraph anchors that actually exist, per work, for evidence and
  // reader-connection freshness checks (M17).
  const paragraphsByWork = new Map();
  for (const record of asArray(passages)) {
    const ids = new Set();
    for (const passage of asArray(record?.passages)) {
      for (const paragraph of asArray(passage?.paragraphs)) {
        if (paragraph?.paragraphId) ids.add(paragraph.paragraphId);
      }
    }
    paragraphsByWork.set(record?.workId, ids);
  }
  const links = asArray(graph?.links);
  const linkCountByWork = new Map();
  for (const link of links) {
    for (const workId of new Set([link.leftWorkId, link.rightWorkId])) {
      if (!workId) continue;
      linkCountByWork.set(workId, (linkCountByWork.get(workId) || 0) + 1);
    }
  }
  const echoLinks = asArray(echoGraph?.links);
  const echoLinkCountByWork = new Map();
  for (const link of echoLinks) {
    for (const workId of new Set([link.leftWorkId, link.rightWorkId])) {
      if (!workId) continue;
      echoLinkCountByWork.set(workId, (echoLinkCountByWork.get(workId) || 0) + 1);
    }
  }

  const catalogWorks = asArray(catalog?.works);
  const knownWorkIds = new Set([
    ...catalogWorks.map((work) => work.workId),
    ...manifestById.keys(),
    ...jobById.keys(),
  ]);
  const catalogById = new Map(catalogWorks.map((work) => [work.workId, work]));
  const issues = [];
  // Files that existed but could not be parsed are corruption signals, not
  // absence; retain them as issues instead of silently reading as missing (M17).
  for (const path of asArray(artifactErrors)) {
    issues.push({ code:'unreadable-artifact', path:String(path) });
  }
  const works = Array.from(knownWorkIds, (workId) => {
    const manifest = manifestById.get(workId);
    const projection = catalogById.get(workId);
    const run = jobById.get(workId);
    const assetRows = asArray(manifest?.assets);
    const availableAssets = assetRows.filter(
      (asset) => asset.availability === 'available',
    );
    const missingAssets = assetRows.filter(
      (asset) => asset.availability === 'missing',
    );
    const passageRecord = passageById.get(workId);
    const semanticRecord = semanticById.get(workId);
    const ideaRecord = ideaById.get(workId);
    const unitRecord = unitsById.get(workId);
    const readerConnectionRecord = readerConnectionsById.get(workId);
    const workIssues = [];
    if (!manifest) workIssues.push('missing-work-manifest');
    if (!projection) workIssues.push('missing-catalog-projection');
    if (!availableAssets.length) workIssues.push('no-available-source');
    if (missingAssets.length) workIssues.push('missing-source');
    if (!run) workIssues.push('not-queued');
    if (run?.error) workIssues.push('processing-error');
    const outcome = processingOutcome(run);
    if (outcome === 'failed') workIssues.push('processing-failed');
    if (outcome === 'waiting-for-ocr') workIssues.push('ocr-required');
    if (outcome === 'waiting-for-stable-source') {
      workIssues.push('unstable-source');
    }
    // Artifact lineage: a stage marked complete whose artifact is missing, or an
    // artifact whose source lineage no longer matches the current asset, means
    // the reported "complete" state is stale or corrupt and must be surfaced,
    // not blessed (M17).
    const currentAsset = availableAssets[0];
    const stageComplete = (name) => run?.stages?.[name]?.status === 'complete';
    if (stageComplete('passages') && !asArray(passageRecord?.passages).length) {
      workIssues.push('missing-completed-passages');
    }
    if (stageComplete('semanticUnits') && !asArray(unitRecord?.units).length) {
      workIssues.push('missing-completed-units');
    }
    if (currentAsset) {
      if (passageRecord?.assetId && passageRecord.assetId !== currentAsset.assetId) {
        workIssues.push('stale-passage-lineage');
      }
      for (const [record, code] of [
        [semanticRecord, 'stale-semantic-lineage'],
        [ideaRecord, 'stale-idea-lineage'],
        [unitRecord, 'stale-unit-lineage'],
      ]) {
        if (record?.sourceFingerprint
          && record.sourceFingerprint !== currentAsset.fingerprint) {
          workIssues.push(code);
        }
      }
    }
    // Deeper freshness: unit evidence and reader connections must resolve to
    // paragraphs that still exist, and reader connections must match the
    // current Echo graph version (M17).
    const workParagraphs = paragraphsByWork.get(workId) || new Set();
    const unitEvidenceDangling = asArray(unitRecord?.units).some((unit) =>
      asArray(unit?.evidence).some((row) =>
        row?.paragraphId && !workParagraphs.has(row.paragraphId)));
    if (unitEvidenceDangling) workIssues.push('dangling-unit-evidence');
    const connections = asArray(readerConnectionRecord?.connections);
    const readerConnectionDangling = connections.some((connection) => {
      if (connection?.source?.paragraphId
        && !workParagraphs.has(connection.source.paragraphId)) return true;
      const targetWorkId = connection?.target?.workId;
      const targetParagraph = connection?.target?.paragraphId;
      if (!targetWorkId || !targetParagraph) return false;
      const targetSet = paragraphsByWork.get(targetWorkId);
      // Only flag when we actually have the target work's paragraphs loaded.
      return targetSet ? !targetSet.has(targetParagraph) : false;
    });
    if (readerConnectionDangling) workIssues.push('stale-reader-connection');
    if (readerConnectionRecord?.graphVersion && echoGraph?.graphVersion
      && readerConnectionRecord.graphVersion !== echoGraph.graphVersion) {
      workIssues.push('stale-reader-graph');
    }
    for (const code of workIssues) {
      issues.push({ code, workId, title:manifest?.title || projection?.title || workId });
    }
    return {
      workId,
      title:manifest?.title || projection?.title || 'Untitled',
      formats:Array.from(new Set(
        assetRows.map((asset) => asset.format).filter(Boolean),
      )).sort(),
      sourceFilenames:assetRows
        .map((asset) => asset.sourceFilename)
        .filter(Boolean)
        .sort(),
      availableAssetCount:availableAssets.length,
      missingAssetCount:missingAssets.length,
      processing: {
        outcome,
        executorClass:run?.executorClass || null,
        updatedAt:run?.updatedAt || null,
        error:run?.error || null,
        stages:Object.fromEntries(
          Object.entries(run?.stages || {}).map(([name, stage]) => [
            name,
            {
              status:stage?.status || 'pending',
              attempts:Number(stage?.attempts) || 0,
              error:stage?.error || null,
              provider:stage?.provider || null,
              model:stage?.model || null,
            },
          ]),
        ),
      },
      passageCount:asArray(passageRecord?.passages).length
        || Number(run?.stages?.passages?.passageCount) || 0,
      conceptCount:asArray(semanticRecord?.concepts).length
        || Number(run?.stages?.deterministicSemantics?.conceptCount) || 0,
      sceneCount:asArray(semanticRecord?.scenes).length
        || Number(run?.stages?.deterministicSemantics?.sceneCount) || 0,
      ideaCount:asArray(ideaRecord?.ideas).length,
      relationshipCount:linkCountByWork.get(workId) || 0,
      semanticUnitCount:asArray(unitRecord?.units).length,
      echoRelationshipCount:echoLinkCountByWork.get(workId) || 0,
      readerConnectionCount:asArray(readerConnectionRecord?.connections).length,
      issues:Array.from(new Set(workIssues)).sort(),
    };
  }).sort((left, right) =>
    left.title.localeCompare(right.title) || left.workId.localeCompare(right.workId));

  for (const collision of asArray(inventory?.collisions)) {
    issues.push({
      code:'path-collision',
      collisionKey:collision.collisionKey,
      paths:collision.paths,
    });
  }
  if (inventory && inventory.completed !== true) {
    issues.push({ code:'incomplete-inventory-generation' });
  }

  return {
    schemaVersion:1,
    recordType:'books.library-report',
    generatedAt,
    library:library ? {
      libraryId:library.libraryId || null,
      rootName:library.rootName || null,
      schemaVersion:library.schemaVersion || null,
    } : null,
    inventory:inventory ? {
      generation:Number(inventory.generation) || 0,
      scannedAt:inventory.scannedAt || null,
      completed:inventory.completed === true,
      counts:inventory.counts || {},
      collisionCount:asArray(inventory.collisions).length,
    } : null,
    totals: {
      works:works.length,
      availableWorks:works.filter((work) => work.availableAssetCount > 0).length,
      missingWorks:works.filter((work) => work.availableAssetCount === 0).length,
      passages:works.reduce((sum, work) => sum + work.passageCount, 0),
      concepts:works.reduce((sum, work) => sum + work.conceptCount, 0),
      scenes:works.reduce((sum, work) => sum + work.sceneCount, 0),
      ideas:works.reduce((sum, work) => sum + work.ideaCount, 0),
      relationships:links.length,
      semanticUnits:works.reduce((sum, work) => sum + work.semanticUnitCount, 0),
      echoes:echoLinks.length,
      readerConnections:works.reduce(
        (sum, work) => sum + work.readerConnectionCount,
        0,
      ),
      connectionReviews:Number(echoQuality?.connections?.reviewed) || 0,
      queryReviews:Number(echoQuality?.queries?.reviewed) || 0,
      issues:issues.length,
    },
    echoQuality:echoQuality ? {
      graphVersion:echoQuality.graphVersion || null,
      connections:echoQuality.connections || null,
      queries:echoQuality.queries || null,
      calibration:echoQuality.calibration || null,
      gate:echoQuality.gate || null,
    } : null,
    processingOutcomes:countBy(works, (work) => work.processing.outcome),
    issueCounts:countBy(issues, 'code'),
    works,
    issues:issues.sort((left, right) =>
      String(left.code).localeCompare(String(right.code))
        || String(left.title || '').localeCompare(String(right.title || ''))),
  };
}

export function formatLibraryReport(report) {
  const lines = [
    '# Lorewell library report',
    '',
    `Generated: ${report.generatedAt}`,
    report.library?.rootName
      ? `Library: ${report.library.rootName} (${report.library.libraryId || 'no id'})`
      : 'Library: unknown',
    '',
    '## Summary',
    '',
    `- Works: ${report.totals.works} (${report.totals.availableWorks} with an available source)`,
    `- Passages: ${report.totals.passages}`,
    `- Concepts / scenes / ideas: ${report.totals.concepts} / ${report.totals.scenes} / ${report.totals.ideas}`,
    `- Cross-book relationships: ${report.totals.relationships}`,
    `- Semantic units / Echo links / reader connections: ${report.totals.semanticUnits} / ${report.totals.echoes} / ${report.totals.readerConnections}`,
    `- Connection / query judgments: ${report.totals.connectionReviews} / ${report.totals.queryReviews}`,
    `- Issues: ${report.totals.issues}`,
    '',
    '## Processing',
    '',
  ];
  for (const [outcome, count] of Object.entries(report.processingOutcomes)) {
    lines.push(`- ${outcome}: ${count}`);
  }
  if (report.echoQuality) {
    lines.push(
      '',
      '## Connection quality',
      '',
      `- Pair review: ${report.echoQuality.connections?.reviewed || 0} / ${report.echoQuality.connections?.target || 0}`,
      `- Query review: ${report.echoQuality.queries?.reviewed || 0} / ${report.echoQuality.queries?.target || 0}`,
      `- Evidence complete: ${report.echoQuality.gate?.evidenceComplete === true}`,
      `- Recommended default: ${report.echoQuality.gate?.recommendedDefault || 'off'}`,
    );
  }
  lines.push('', '## Works', '');
  for (const work of report.works) {
    const issueSuffix = work.issues.length
      ? ` · issues: ${work.issues.join(', ')}`
      : '';
    lines.push(
      `- ${work.title} — ${work.processing.outcome} · ` +
      `${work.passageCount} passages · ${work.ideaCount} ideas · ` +
      `${work.relationshipCount} relationships · ${work.readerConnectionCount} reader Echoes${issueSuffix}`,
    );
  }
  if (report.issues.length) {
    lines.push('', '## Issue counts', '');
    for (const [code, count] of Object.entries(report.issueCounts)) {
      lines.push(`- ${code}: ${count}`);
    }
  }
  return lines.join('\n') + '\n';
}
