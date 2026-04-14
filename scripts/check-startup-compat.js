#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import process from 'process';

const ROOT = process.cwd();

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function major(versionSpec = '') {
  const match = String(versionSpec).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function walkFiles(dirPath, collector) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, collector);
      continue;
    }
    collector(fullPath);
  }
}

function ensureWritableDirectory(dirPath, issues) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    issues.push(`Directory is not writable: ${dirPath} (${error.message})`);
  }
}

function validateRoutePatterns(expressMajor, issues) {
  if (expressMajor < 5) {
    return;
  }

  const routeFiles = [];
  walkFiles(path.join(ROOT, 'src', 'routes'), (filePath) => {
    if (filePath.endsWith('.js')) {
      routeFiles.push(filePath);
    }
  });

  const routeCallRegex = /(router|app)\.(?:get|post|put|patch|delete|use|all)\(\s*(["'`])([^"'`]+)\2/g;
  const legacyOptionalRegex = /:[A-Za-z0-9_]+\?/;
  const legacyRegexParamRegex = /:[A-Za-z0-9_]+\([^)]*\)/;
  const unnamedWildcardRegex = /(^|\/)\*(\/|$)/;

  for (const filePath of routeFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    let match;

    while ((match = routeCallRegex.exec(source)) !== null) {
      const routePath = match[3];
      if (legacyOptionalRegex.test(routePath)) {
        issues.push(`Legacy optional route syntax in ${filePath}: "${routePath}" (use two explicit routes or braces syntax)`);
      }
      if (legacyRegexParamRegex.test(routePath)) {
        issues.push(`Legacy regex route param syntax in ${filePath}: "${routePath}" (use wildcard *name for Express 5)`);
      }
      if (unnamedWildcardRegex.test(routePath)) {
        issues.push(`Unnamed wildcard in ${filePath}: "${routePath}" (use *name instead of *)`);
      }
    }
  }
}

function main() {
  const issues = [];

  const packageJson = readJson(path.join(ROOT, 'package.json'));
  const expressVersion = packageJson?.dependencies?.express || packageJson?.devDependencies?.express || '';
  const expressMajor = major(expressVersion);

  validateRoutePatterns(expressMajor, issues);

  const settings = readJson(path.join(ROOT, 'config', 'app-settings.json'), {});
  const envContentRoot = (process.env.CONTENT_ROOT || '').trim();
  const requestedContentRoot = envContentRoot || settings.contentRoot || path.join(ROOT, 'data');
  const contentRoot = path.resolve(requestedContentRoot);

  const requiredDirs = [
    path.join(ROOT, 'config'),
    path.join(ROOT, 'config', 'hero'),
    contentRoot,
    path.join(contentRoot, 'content'),
    path.join(contentRoot, 'streams'),
    path.join(contentRoot, 'converted'),
    path.join(contentRoot, 'logs'),
    path.join(contentRoot, 'temp')
  ];

  for (const dirPath of requiredDirs) {
    ensureWritableDirectory(dirPath, issues);
  }

  if (issues.length > 0) {
    console.error(`[StartupDoctor] FAILED: found ${issues.length} issue(s)`);
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  console.log('[StartupDoctor] OK');
  console.log(`- express major: ${expressMajor || 'unknown'} (${expressVersion || 'not found'})`);
  console.log(`- content root: ${contentRoot}`);
  console.log(`- checked writable directories: ${requiredDirs.length}`);
}

main();
