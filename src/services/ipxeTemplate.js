'use strict';

const DEFAULT_IQN_PREFIX = 'iqn.2005-10.org.freenas.ctl';
const GOLDEN_TARGET = 'win-golden';

function resolveIqnPrefix(settings) {
  const prefix = settings && settings.iqn_prefix;
  return typeof prefix === 'string' && prefix.length > 0 ? prefix : DEFAULT_IQN_PREFIX;
}

function substitute(template, { target, host, iqnPrefix }) {
  return template
    .replace(/\{\{TARGET\}\}/g, target)
    .replace(/\{\{HOST\}\}/g, host)
    .replace(/\{\{IQN_PREFIX\}\}/g, iqnPrefix);
}

function defaultScript({ target, host, iqnPrefix }) {
  return `#!ipxe\nsanboot iscsi:${host}::::${iqnPrefix}:${target}\n`;
}

function renderBootScript({ client, settings, truenasHost }) {
  const iqnPrefix = resolveIqnPrefix(settings);
  const host = truenasHost;

  if (typeof client.raw_override === 'string' && client.raw_override.length > 0) {
    return substitute(client.raw_override, {
      target: client.target_name,
      host,
      iqnPrefix,
    });
  }

  const target = client.boot_golden_once ? GOLDEN_TARGET : client.target_name;
  const tokens = { target, host, iqnPrefix };

  if (settings && typeof settings.ipxe_template === 'string' && settings.ipxe_template.length > 0) {
    return substitute(settings.ipxe_template, tokens);
  }

  return defaultScript(tokens);
}

// The golden iSCSI target name is the last path segment of GOLDEN_ZVOL
// (Main_pool/iscsi/win-golden -> win-golden). Resolved from config rather
// than hardcoded so overriding GOLDEN_ZVOL keeps the boot script and the
// golden-target session check (services/goldenBuild.js) in agreement.
function goldenTargetName(goldenZvol) {
  return String(goldenZvol || '').split('/').pop();
}

// Golden Build Mode 'boot_installed'-phase script: after the image has been
// applied and bcdboot has run, the machine must boot the installed OS
// directly from the golden zvol — a plain sanboot, no WinPE. This is what
// previously required a manual static-file override on the old ipxeboot
// container the moment the install finished.
function renderGoldenBootScript({ settings, truenasHost, goldenZvol }) {
  const iqnPrefix = resolveIqnPrefix(settings);
  const target = goldenTargetName(goldenZvol);
  return defaultScript({ target, host: truenasHost, iqnPrefix });
}

// Golden Build Mode 'install'-phase script. Unlike renderBootScript (sanboot
// into a per-client clone), this sanhooks the machine directly onto the live
// golden zvol as a local disk and chains into WinPE to service it in place —
// so anything written lands permanently on the golden image. `keep-san 1`
// keeps the iSCSI connection alive across the chain so WinPE sees drive 0x80.
// Host / IQN-prefix / golden-target resolution match renderBootScript's.
function renderGoldenBuildScript({ settings, truenasHost, goldenZvol, winpeChainUrl }) {
  const iqnPrefix = resolveIqnPrefix(settings);
  const target = goldenTargetName(goldenZvol);
  return [
    '#!ipxe',
    'set keep-san 1',
    `sanhook --drive 0x80 iscsi:${truenasHost}::::${iqnPrefix}:${target}`,
    `chain ${winpeChainUrl}`,
  ].join('\n') + '\n';
}

function renderUnknownScript(mac) {
  return [
    '#!ipxe',
    `echo Machine ${mac} is not yet registered in FleetDeck.`,
    `echo It has been logged as "discovered" for one-click adoption in the FleetDeck UI.`,
    'echo Dropping to an iPXE shell so you are not stranded.',
    'shell',
  ].join('\n') + '\n';
}

module.exports = {
  renderBootScript, renderUnknownScript, renderGoldenBuildScript,
  renderGoldenBootScript, goldenTargetName, DEFAULT_IQN_PREFIX,
};
