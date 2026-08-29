import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSETS = {
  smart: '项目 1.smart',
  awl: 'Process_4Stage_DIDO_IMPORT.awl',
  flow: '工序流程.txt',
  hmiFinal: '西门子_一键完整导入_光科DIDO_最终版.csv',
  hmiAlarm: join('hmi_assets', 'alarm_page_controls_latest.csv'),
  hmiManual: join('hmi_assets', 'manual_page_controls_latest.csv'),
  hmiProcess: join('hmi_assets', 'current_process_controls_latest.csv'),
  hmiConfig: join('hmi_assets', 'config_page_controls_latest.csv'),
};

const UPPER_COMPUTER_FILES = {
  entry: 'index.tsx',
  offlineApp: join('components', 'OfflineClosureApp.tsx'),
  config: join('server', 'src', 'config.ts'),
  main: join('server', 'src', 'main.ts'),
  legacyField: join('server', 'src', 'index.ts'),
  fieldGate: join('server', 'src', 'field-runtime-gate.ts'),
  offlineServer: join('server', 'src', 'closure', 'offline-server.ts'),
};

export async function analyzeFieldAssets(assetRoot, options = {}) {
  const root = resolve(assetRoot);
  const deployment = options.deployment;
  const baseline = options.baseline === undefined
    ? await loadBaseline(options.baselinePath ?? fileURLToPath(new URL('../config/field-asset-baseline.json', import.meta.url)))
    : options.baseline;
  const files = await Promise.all(Object.entries(ASSETS).map(async ([key, relativePath]) => {
    const path = join(root, relativePath);
    try {
      const content = await readFile(path);
      const info = await stat(path);
      return [key, { path, content, text: decodeText(content), modifiedAt: info.mtime.toISOString() }];
    } catch (error) {
      if (isNotFound(error)) return [key, undefined];
      throw error;
    }
  }));
  const assets = Object.fromEntries(files);
  const blockers = [];
  const upperComputer = options.appRoot === null
    ? { status: 'not_checked', issues: [] }
    : await verifyUpperComputer(options.appRoot ?? process.cwd());

  for (const [key, asset] of Object.entries(assets)) {
    if (!asset) blockers.push(blocker('FIELD_ASSET_MISSING', 'critical', `${key}: ${ASSETS[key]}`));
  }
  const assetSummary = summarizeAssets(assets);
  const baselineStatus = verifyBaseline(assetSummary, baseline);
  for (const mismatch of baselineStatus.mismatches) {
    blockers.push(blocker('FIELD_ASSET_HASH_MISMATCH', 'critical', `Expected ${mismatch.expected}, received ${mismatch.actual}.`, { asset: mismatch.asset }));
  }
  blockers.push(...upperComputer.issues);
  if (blockers.some((entry) => entry.id === 'FIELD_ASSET_MISSING')) {
    return { assetRoot: root, readyForFieldRelease: false, assets: assetSummary, baseline: baselineStatus, upperComputer, blockers };
  }

  const awl = assets.awl.text;
  const flow = assets.flow.text;
  const hmiFinal = assets.hmiFinal.text;
  const hmiAlarm = assets.hmiAlarm.text;
  const hmiManual = assets.hmiManual.text;
  const hmiProcess = assets.hmiProcess.text;
  const hmiConfig = assets.hmiConfig.text;

  if (/\bM2\.4\b/.test(awl) || /\bM2\.4\b/.test(flow)) {
    blockers.push(blocker('PLC_MANUAL_BYPASS_PRESENT', 'critical', 'M2.4 MANUAL_ENABLE appears in the PLC/flow assets.'));
  }
  if (/\bM2\.1\b/.test(awl) || /\bHMI_RESET\b/.test(hmiFinal) || /\bHMI_RESET\b/.test(hmiAlarm)) {
    blockers.push(blocker('PLC_HMI_RESET_MECHANISM_PRESENT', 'critical', 'The field PLC/HMI assets still expose the removed M2.1/HMI_RESET mechanism.'));
  }
  if (!hasVerticalFeedbackWithSafeTimeout(awl)) {
    blockers.push(blocker('PLC_VERTICAL_FEEDBACK_BYPASSED', 'critical', 'Vertical completion must use upper-limit I0.3/lower-limit I0.4 and every T44–T47 timeout must stop and alarm the cycle.'));
  }
  if (!hasVerticalAddressContract(awl, flow, hmiProcess, hmiManual)) {
    blockers.push(blocker('PLC_VERTICAL_ADDRESS_DRIFT', 'critical', 'The current AWL, process flow, and HMI vertical limit references must all use I0.3/I0.4; legacy I1.3/I1.4 references are not accepted.'));
  }
  if (hmiWritesPhysicalOutput(hmiFinal, hmiManual)) {
    blockers.push(blocker('HMI_DIRECT_PHYSICAL_OUTPUT_WRITE', 'critical', 'The HMI exposes a physical Q address through a writable variable or button.'));
  }
  if (hmiWritesSafetyOverride(hmiFinal, hmiManual)) {
    blockers.push(blocker('HMI_SAFETY_OVERRIDE_WRITE', 'critical', 'HMI assets expose M2.2 SAFETY_LIMIT through an operator-writable control.'));
  }
  if (hmiWritesAutomaticCommand(hmiFinal, hmiManual)) {
    blockers.push(blocker('HMI_AUTOMATIC_COMMAND_WRITE', 'critical', 'HMI writes M29.x, which is reserved for PLC automatic actions and must remain read-only.'));
  }
  if (!hasManualCommandIsolation(awl)) {
    blockers.push(blocker('PLC_MANUAL_COMMAND_NOT_ISOLATED', 'critical', 'Manual M30.x commands must be gated by safety and AUTO_RUN before they can merge with automatic M29.x actions.'));
  }
  if (/\bVW690\b/.test(hmiConfig) && /\bM40\.0\b/.test(hmiConfig) && !/\bVW690\b/.test(awl) && !/\bM40\.0\b/.test(awl)) {
    blockers.push(blocker('HMI_CONFIG_NOT_IMPLEMENTED', 'high', 'HMI configuration controls have no matching PLC implementation in the four-stage AWL.'));
  }
  if (!hasAutomaticEmcOutput(awl) || /(?:不触发Q1\.3|NO_EMC_OUTPUT)/.test(hmiProcess)) {
    blockers.push(blocker('EMC_AUTO_OUTPUT_NOT_IMPLEMENTED', 'high', 'The EMC stage must automatically command Q1.3 through a PLC-controlled bit and the HMI must not mark it as skipped.'));
  }
  if (deployment && deployment.plcBinaryImport !== 'verified') {
    blockers.push(blocker('PLC_BINARY_IMPORT_PENDING', 'critical', 'The audited AWL has not been imported, compiled, and CRC-verified in the latest .smart project.'));
  }
  if (deployment && deployment.hmiProjectImport !== 'verified') {
    blockers.push(blocker('HMI_PROJECT_IMPORT_PENDING', 'critical', 'The audited HMI CSV/control assets have not been imported and checked in the editable HMI project.'));
  }

  return {
    assetRoot: root,
    readyForFieldRelease: blockers.length === 0,
    assets: assetSummary,
    baseline: baselineStatus,
    deployment: deployment ?? { status: 'not_checked' },
    upperComputer,
    blockers,
  };
}

function summarizeAssets(assets) {
  return Object.fromEntries(Object.entries(assets).map(([key, asset]) => [key, asset && {
    file: basename(asset.path),
    modifiedAt: asset.modifiedAt,
    sha256: createHash('sha256').update(asset.content).digest('hex').toUpperCase(),
  }]));
}

export function hasVerticalFeedbackWithSafeTimeout(awl) {
  const feedbackSteps = [
    ['M10.0', 'I0.3', 'M12.0'],
    ['M10.3', 'I0.4', 'M12.3'],
    ['M10.5', 'I0.3', 'M12.5'],
    ['M10.7', 'I0.4', 'M12.7'],
  ];
  const timeoutSteps = [
    ['M10.0', 'I0.3', 'T44', 'M15.0'],
    ['M10.3', 'I0.4', 'T45', 'M15.1'],
    ['M10.5', 'I0.3', 'T46', 'M15.2'],
    ['M10.7', 'I0.4', 'T47', 'M15.3'],
  ];
  const feedbackPresent = feedbackSteps.every(([step, input, complete]) => new RegExp(`LD\\s+${escapeAddress(step)}[\\s\\S]{0,48}A\\s+${escapeAddress(input)}[\\s\\S]{0,48}=\\s+${escapeAddress(complete)}`).test(awl));
  const timeoutPresent = timeoutSteps.every(([step, input, timer, fault]) => new RegExp(`LD\\s+${escapeAddress(step)}[\\s\\S]{0,32}AN\\s+${escapeAddress(input)}[\\s\\S]{0,64}TON\\s+${timer}[\\s\\S]{0,80}LD\\s+${timer}[\\s\\S]{0,48}(?:=|S)\\s+${escapeAddress(fault)}`).test(awl));
  const safeShutdown = /LD\s+M20\.0[\s\S]{0,48}O\s+M15\.0[\s\S]{0,48}O\s+M15\.1[\s\S]{0,48}O\s+M15\.2[\s\S]{0,48}O\s+M15\.3[\s\S]{0,48}=\s+M0\.2[\s\S]{0,64}S\s+M2\.0,\s*1[\s\S]{0,160}R\s+Q0\.0,\s*8[\s\S]{0,96}R\s+Q1\.0,\s*4/.test(awl);
  return feedbackPresent && timeoutPresent && safeShutdown;
}

export function hasVerticalAddressContract(awl, flow, hmiProcess, hmiManual) {
  const sources = [awl, flow, hmiProcess, hmiManual];
  const combined = sources.join('\n');
  return sources.every((source) => /\bI0\.3\b/.test(source) && /\bI0\.4\b/.test(source))
    && !/\bI1\.3\b|\bI1\.4\b/.test(combined);
}

function hmiWritesPhysicalOutput(hmiFinal, hmiManual) {
  const writableQVariable = /(?:读写|WRITE)[^\r\n]*\bQ\d{3}\.\d\b/i.test(hmiFinal);
  const physicalQButton = /(?:透明按钮|标准按钮|多状态按钮|按钮|开关)[^\r\n]*\bQ\d\.\d\b|\bQ\d\.\d\b[^\r\n]*(?:透明按钮|标准按钮|多状态按钮|按钮|开关)/.test(hmiManual);
  return writableQVariable || physicalQButton;
}

function hmiWritesSafetyOverride(hmiFinal, hmiManual) {
  const writableSafetyVariable = /(?:读写|WRITE)[^\r\n]*\bM002\.2\b/i.test(hmiFinal);
  const safetyButton = /(?:透明按钮|标准按钮|多状态按钮|按钮|开关)[^\r\n]*(?:SAFETY_LIMIT|M2\.2)|(?:SAFETY_LIMIT|M2\.2)[^\r\n]*(?:透明按钮|标准按钮|多状态按钮|按钮|开关)/.test(hmiManual);
  return writableSafetyVariable || safetyButton;
}

function hmiWritesAutomaticCommand(hmiFinal, hmiManual) {
  const writableAutomaticCommand = /(?:读写|WRITE)[^\r\n]*\bM029\.\d\b/i.test(hmiFinal);
  const automaticActionButton = /动作按钮[^\r\n]*\bM29\.\d\b|\bM29\.\d\b[^\r\n]*动作按钮/.test(hmiManual);
  return writableAutomaticCommand || automaticActionButton;
}

function hasAutomaticEmcOutput(awl) {
  return /LD\s+M11\.2[\s\S]{0,80}S\s+M29\.5,\s*1/.test(awl)
    && /LD\s+M32\.7[\s\S]{0,64}O\s+M29\.5[\s\S]{0,96}=\s+M31\.6/.test(awl)
    && /LD\s+M31\.6[\s\S]{0,48}=\s+Q1\.3/.test(awl);
}

function hasManualCommandIsolation(awl) {
  const manualGate = /LD\s+M31\.7[\s\S]{0,32}AN\s+M0\.0[\s\S]{0,48}=\s+M32\.0/.test(awl);
  const manualMaps = Array.from({ length: 7 }, (_, index) => new RegExp(`LD\\s+M30\\.${index}[\\s\\S]{0,32}A\\s+M32\\.0[\\s\\S]{0,48}=\\s+M32\\.${index + 1}`).test(awl)).every(Boolean);
  const mergedOutputs = [
    ['M32.1', 'M29.3', 'M31.0'],
    ['M32.2', 'M29.1', 'M31.1'],
    ['M32.4', 'M29.0', 'M31.3'],
    ['M32.6', 'M29.4', 'M31.5'],
    ['M32.7', 'M29.5', 'M31.6'],
  ].every(([manual, automatic, output]) => new RegExp(`LD\\s+${escapeAddress(manual)}[\\s\\S]{0,80}O\\s+${escapeAddress(automatic)}[\\s\\S]{0,160}=\\s+${escapeAddress(output)}`).test(awl));
  return manualGate && manualMaps && mergedOutputs;
}

function escapeAddress(address) {
  return address.replace('.', '\\.');
}

function decodeText(content) {
  const utf8 = content.toString('utf8');
  const gbk = new TextDecoder('gbk').decode(content);
  return `${utf8}\n${gbk}`;
}

function blocker(id, severity, evidence, details = {}) {
  return { id, severity, evidence, ...details };
}

function verifyBaseline(assets, baseline) {
  if (!baseline) return { status: 'not_configured', mismatches: [] };
  const expectedAssets = baseline.assets ?? {};
  const mismatches = Object.entries(assets).flatMap(([asset, summary]) => {
    if (!summary) return [];
    const expected = expectedAssets[asset];
    return expected === summary.sha256 ? [] : [{ asset, expected: expected ?? 'MISSING', actual: summary.sha256 }];
  });
  return { status: mismatches.length === 0 ? 'verified' : 'drifted', mismatches };
}

async function loadBaseline(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadDeployment(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isNotFound(error)) return { plcBinaryImport: 'pending', hmiProjectImport: 'pending' };
    throw error;
  }
}

function isNotFound(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function verifyUpperComputer(appRoot) {
  const root = resolve(appRoot);
  const files = await Promise.all(Object.entries(UPPER_COMPUTER_FILES).map(async ([key, relativePath]) => {
    try {
      return [key, await readFile(join(root, relativePath), 'utf8')];
    } catch (error) {
      if (isNotFound(error)) return [key, undefined];
      throw error;
    }
  }));
  const source = Object.fromEntries(files);
  const issues = [];

  for (const [key, text] of Object.entries(source)) {
    if (text === undefined) issues.push(blocker('UPPER_COMPUTER_SOURCE_MISSING', 'critical', `${key}: ${UPPER_COMPUTER_FILES[key]}`, { source: key }));
  }
  if (issues.length > 0) return { status: 'drifted', issues };

  if (!source.entry.includes('OfflineClosureApp') || /from\s+['"]\.\/App['"]/.test(source.entry)) {
    issues.push(blocker('UPPER_COMPUTER_OFFLINE_ENTRY_REGRESSED', 'critical', 'The frontend entry no longer exclusively renders OfflineClosureApp.'));
  }
  if (/\/api\/do\b|\bset_do\b|mqtt\.connect|external\/upload/.test(source.offlineApp)) {
    issues.push(blocker('UPPER_COMPUTER_DIRECT_IO_REGRESSION', 'critical', 'The offline UI contains a direct I/O, MQTT, or external upload call.'));
  }
  if (!source.config.includes("process.env.CLOSURE_MODE === 'field' ? 'field' : 'offline'")) {
    issues.push(blocker('UPPER_COMPUTER_OFFLINE_DEFAULT_REGRESSED', 'critical', 'The server configuration no longer defaults CLOSURE_MODE to offline.'));
  }
  if (!source.main.includes('assertSupportedRuntimeMode') || !source.main.includes('startOfflineServer')) {
    issues.push(blocker('UPPER_COMPUTER_OFFLINE_RUNTIME_REGRESSED', 'critical', 'The main runtime no longer selects the isolated offline server.'));
  }
  if (!source.main.includes('assertSupportedRuntimeMode') || !source.fieldGate.includes('FIELD_RUNTIME_DISABLED')) {
    issues.push(blocker('UPPER_COMPUTER_FIELD_RUNTIME_GATE_REGRESSED', 'critical', 'The legacy direct-I/O field runtime is no longer explicitly blocked.'));
  }
  if (!source.legacyField.includes('assertFieldRuntimeDisabled')) {
    issues.push(blocker('UPPER_COMPUTER_LEGACY_FIELD_RUNTIME_REGRESSED', 'critical', 'The legacy direct-I/O entry can run without the field-runtime hard gate.'));
  }
  if (!source.offlineServer.includes("server.listen(port, '127.0.0.1'")) {
    issues.push(blocker('UPPER_COMPUTER_LOOPBACK_BOUNDARY_REGRESSED', 'critical', 'The offline server no longer binds only to 127.0.0.1.'));
  }
  return { status: issues.length === 0 ? 'verified' : 'drifted', issues };
}

async function main() {
  const assetRoot = process.env.FIELD_ASSET_ROOT || 'D:\\code\\PLC\\SMART200-FLAME';
  const deploymentPath = process.env.FIELD_DEPLOYMENT_STATUS_PATH
    ?? fileURLToPath(new URL('../config/field-deployment-status.json', import.meta.url));
  const deployment = await loadDeployment(deploymentPath);
  const report = await analyzeFieldAssets(assetRoot, { baselinePath: process.env.FIELD_BASELINE_PATH, deployment });
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--strict') && !report.readyForFieldRelease) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
