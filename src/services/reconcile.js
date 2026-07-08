'use strict';

function leafOf(path) {
  return String(path || '').split('/').pop();
}

async function scanReconciliation(ctx, clients) {
  const [targets, extents, targetExtents] = await Promise.all([
    ctx.adapter.queryTargets([]),
    ctx.adapter.queryExtents([]),
    ctx.adapter.queryTargetExtents([]),
  ]);

  const clientTargetNames = new Set(clients.map((c) => c.target_name));
  const goldenLeaf = leafOf(ctx.config.goldenZvol);

  const trueNasOnly = [];
  for (const target of targets) {
    const name = target && target.name;
    if (!name) continue;
    if (clientTargetNames.has(name)) continue;
    if (name === goldenLeaf || name === 'win-golden') continue; // never surface the golden target itself
    const te = (targetExtents || []).find((x) => x && x.target === target.id);
    const extent = te ? (extents || []).find((x) => x && x.id === te.extent) : null;
    const disk = extent && extent.disk ? String(extent.disk) : null;
    trueNasOnly.push({
      targetId: target.id,
      targetName: name,
      extentId: extent ? extent.id : null,
      zvol: disk ? disk.replace(/^zvol\//, '') : null,
    });
  }

  const trueNasTargetNames = new Set(targets.map((t) => t && t.name).filter(Boolean));
  const dbOnly = clients.filter((c) => !trueNasTargetNames.has(c.target_name));

  return { trueNasOnly, dbOnly };
}

module.exports = { scanReconciliation, leafOf };
