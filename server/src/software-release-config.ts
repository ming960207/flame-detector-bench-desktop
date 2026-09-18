import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SoftwareReleaseSource = 'git' | 'gitee';

export interface SoftwareRepositorySlug {
  owner: string;
  repo: string;
}

export interface SoftwareReleaseConfig {
  source: SoftwareReleaseSource;
  label: string;
  branch: string;
  repository: string;
  remoteUrl: string;
  remoteName: 'origin' | 'gitee';
  repositorySlug: SoftwareRepositorySlug | null;
  tokenEnvironmentName: string;
  tokenEnvironmentAliases: string[];
  usernameEnvironmentName: string;
}

const DEFAULT_BRANCH = 'refactor/unified-backend';
const DEFAULT_CHANNELS = {
  git: {
    label: 'GitHub',
    repository: 'https://github.com/ming960207/flame-detector-bench-desktop',
    remoteUrl: 'https://github.com/ming960207/flame-detector-bench-desktop.git',
  },
  gitee: {
    label: 'Gitee',
    repository: 'https://gitee.com/mingchangpeng/flame-detector-bench-desktop',
    remoteUrl: 'https://gitee.com/mingchangpeng/flame-detector-bench-desktop.git',
  },
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSoftwareRepository(value: string): string {
  return text(value).replace(/\/+$/, '').replace(/\.git$/i, '');
}

export function parseSoftwareRepositorySlug(repository: string): SoftwareRepositorySlug | null {
  try {
    const url = new URL(normalizeSoftwareRepository(repository));
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0]!, repo: parts.slice(1).join('/') };
  } catch {
    return null;
  }
}

export function parseSoftwareReleaseConfig(input: unknown): SoftwareReleaseConfig {
  const root = record(input);
  const source: SoftwareReleaseSource = root.source === 'gitee' ? 'gitee' : 'git';
  const defaults = DEFAULT_CHANNELS[source];
  const channel = record(root[source]);
  const repository = normalizeSoftwareRepository(text(channel.repository) || defaults.repository);
  const remoteUrl = text(channel.remoteUrl) || `${repository}.git`;
  const repositorySlug = parseSoftwareRepositorySlug(repository);

  return {
    source,
    label: text(channel.label) || defaults.label,
    branch: text(root.branch) || DEFAULT_BRANCH,
    repository,
    remoteUrl,
    remoteName: source === 'gitee' ? 'gitee' : 'origin',
    repositorySlug,
    tokenEnvironmentName: source === 'gitee' ? 'GITEE_ACCESS_TOKEN' : 'FLAME_BENCH_GITHUB_TOKEN',
    tokenEnvironmentAliases: source === 'gitee' ? ['FLAME_BENCH_GITEE_TOKEN'] : [],
    usernameEnvironmentName: source === 'gitee' ? 'FLAME_BENCH_GITEE_USERNAME' : 'FLAME_BENCH_GITHUB_USERNAME',
  };
}

export function resolveSoftwareReleaseConfigPath(repositoryRoot?: string): string {
  const configuredPath = text(process.env.FLAME_BENCH_RELEASE_CONFIG);
  if (configuredPath) return resolve(configuredPath);

  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const root = repositoryRoot ? resolve(repositoryRoot) : moduleRoot;
  const candidates = [
    join(root, 'config', 'release-source.json'),
    join(moduleRoot, 'config', 'release-source.json'),
    join(process.cwd(), 'config', 'release-source.json'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function loadSoftwareReleaseConfig(repositoryRoot?: string): SoftwareReleaseConfig {
  const configPath = resolveSoftwareReleaseConfigPath(repositoryRoot);
  try {
    return parseSoftwareReleaseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return parseSoftwareReleaseConfig({});
  }
}

export function hasSoftwareReleaseConfig(repositoryRoot?: string): boolean {
  return existsSync(resolveSoftwareReleaseConfigPath(repositoryRoot));
}
