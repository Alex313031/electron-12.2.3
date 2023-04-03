#!/usr/bin/env node

const { GitProcess } = require('dugite');
const childProcess = require('child_process');
const fs = require('fs');
const klaw = require('klaw');
const minimist = require('minimist');
const path = require('path');

const SOURCE_ROOT = path.normalize(path.dirname(__dirname));
const DEPOT_TOOLS = path.resolve(SOURCE_ROOT, '..', 'third_party', 'depot_tools');

const IGNORELIST = new Set([
  ['shell', 'browser', 'resources', 'win', 'resource.h'],
  ['shell', 'browser', 'notifications', 'mac', 'notification_center_delegate.h'],
  ['shell', 'browser', 'ui', 'cocoa', 'event_dispatching_window.h'],
  ['shell', 'browser', 'ui', 'cocoa', 'NSColor+Hex.h'],
  ['shell', 'browser', 'ui', 'cocoa', 'NSString+ANSI.h'],
  ['shell', 'common', 'node_includes.h'],
  ['spec', 'static', 'jquery-2.0.3.min.js'],
  ['spec', 'ts-smoke', 'electron', 'main.ts'],
  ['spec', 'ts-smoke', 'electron', 'renderer.ts'],
  ['spec', 'ts-smoke', 'runner.js']
].map(tokens => path.join(SOURCE_ROOT, ...tokens)));

const IS_WINDOWS = process.platform === 'win32';

function spawnAndCheckExitCode (cmd, args, opts) {
  opts = Object.assign({ stdio: 'inherit' }, opts);
  const status = childProcess.spawnSync(cmd, args, opts).status;
  if (status) process.exit(status);
}

function cpplint (args) {
  const result = childProcess.spawnSync(IS_WINDOWS ? 'cpplint.bat' : 'cpplint.py', args, { encoding: 'utf8', shell: true });
  // cpplint.py writes EVERYTHING to stderr, including status messages
  if (result.stderr) {
    for (const line of result.stderr.split(/[\r\n]+/)) {
      if (line.length && !line.startsWith('Done processing ') && line !== 'Total errors found: 0') {
        console.warn(line);
      }
    }
  }
  if (result.status !== 0) {
    if (result.error) console.error(result.error);
    process.exit(result.status || 1);
  }
}

function isObjCHeader (filename) {
  return /\/(mac|cocoa)\//.test(filename);
}

const LINTERS = [{
  key: 'c++',
  roots: ['shell'],
  test: filename => filename.endsWith('.cc') || (filename.endsWith('.h') && !isObjCHeader(filename)),
  run: (opts, filenames) => {
    if (opts.fix) {
      spawnAndCheckExitCode('python', ['script/run-clang-format.py', '--fix', ...filenames]);
    } else {
      spawnAndCheckExitCode('python', ['script/run-clang-format.py', ...filenames]);
    }
    cpplint(filenames);
  }
}, {
  key: 'objc',
  roots: ['shell'],
  test: filename => filename.endsWith('.mm'),
  run: (opts, filenames) => {
    if (opts.fix) {
      spawnAndCheckExitCode('python', ['script/run-clang-format.py', '--fix', ...filenames]);
    } else {
      spawnAndCheckExitCode('python', ['script/run-clang-format.py', ...filenames]);
    }
    const filter = [
      '-readability/casting',
      '-whitespace/braces',
      '-whitespace/indent',
      '-whitespace/parens'
    ];
    cpplint(['--extensions=mm', `--filter=${filter.join(',')}`, ...filenames]);
  }
}, {
  key: 'python',
  roots: ['script'],
  test: filename => filename.endsWith('.py'),
  run: (opts, filenames) => {
    const rcfile = path.join(DEPOT_TOOLS, 'pylintrc');
    const args = ['--rcfile=' + rcfile, ...filenames];
    const env = Object.assign({ PYTHONPATH: path.join(SOURCE_ROOT, 'script') }, process.env);
    spawnAndCheckExitCode('pylint.py', args, { env });
  }
}, {
  key: 'javascript',
  roots: ['build', 'default_app', 'lib', 'npm', 'script', 'spec', 'spec-main'],
  ignoreRoots: ['spec/node_modules', 'spec-main/node_modules'],
  test: filename => filename.endsWith('.js') || filename.endsWith('.ts'),
  run: (opts, filenames) => {
    const cmd = path.join(SOURCE_ROOT, 'node_modules', '.bin', 'eslint');
    const args = ['--cache', '--ext', '.js,.ts'];
    if (opts.fix) args.unshift('--fix');
    // Windows has a max command line length of 2047 characters, so we can't provide
    // all of the filenames without going over that. To work around it, run eslint
    // multiple times and chunk the filenames so that each run is under that limit.
    // Use a much higher limit on other platforms which will effectively be a no-op.
    const MAX_FILENAME_ARGS_LENGTH = IS_WINDOWS ? 1900 : 100 * 1024;
    const cmdOpts = { stdio: 'inherit', shell: IS_WINDOWS, cwd: SOURCE_ROOT };
    if (IS_WINDOWS) {
      // When running with shell spaces in filenames are problematic
      filenames = filenames.map(filename => `"${filename}"`);
    }
    const chunkedFilenames = filenames.reduce((chunkedFilenames, filename) => {
      const currentChunk = chunkedFilenames[chunkedFilenames.length - 1];
      const currentChunkLength = currentChunk.reduce((totalLength, _filename) => totalLength + _filename.length, 0);
      if (currentChunkLength + filename.length > MAX_FILENAME_ARGS_LENGTH) {
        chunkedFilenames.push([filename]);
      } else {
        currentChunk.push(filename);
      }
      return chunkedFilenames;
    }, [[]]);
    const allOk = chunkedFilenames.map(filenames => {
      const result = childProcess.spawnSync(cmd, [...args, ...filenames], cmdOpts);
      if (result.error) {
        console.error(result.error);
        process.exit(result.status || 1);
      }
      return result.status === 0;
    }).every(x => x);
    if (!allOk) {
      process.exit(1);
    }
  }
}, {
  key: 'gn',
  roots: ['.'],
  test: filename => filename.endsWith('.gn') || filename.endsWith('.gni'),
  run: (opts, filenames) => {
    const allOk = filenames.map(filename => {
      const env = Object.assign({
        CHROMIUM_BUILDTOOLS_PATH: path.resolve(SOURCE_ROOT, '..', 'buildtools'),
        DEPOT_TOOLS_WIN_TOOLCHAIN: '0'
      }, process.env);
      // Users may not have depot_tools in PATH.
      env.PATH = `${env.PATH}${path.delimiter}${DEPOT_TOOLS}`;
      const args = ['format', filename];
      if (!opts.fix) args.push('--dry-run');
      const result = childProcess.spawnSync('gn', args, { env, stdio: 'inherit', shell: true });
      if (result.status === 0) {
        return true;
      } else if (result.status === 2) {
        console.log(`GN format errors in "${filename}". Run 'gn format "${filename}"' or rerun with --fix to fix them.`);
        return false;
      } else {
        console.log(`Error running 'gn format --dry-run "${filename}"': exit code ${result.status}`);
        return false;
      }
    }).every(x => x);
    if (!allOk) {
      process.exit(1);
    }
  }
}, {
  key: 'patches',
  roots: ['patches'],
  test: () => true,
  run: (opts, filenames) => {
    const patchesDir = path.resolve(__dirname, '../patches');
    for (const patchTarget of fs.readdirSync(patchesDir)) {
      const targetDir = path.resolve(patchesDir, patchTarget);
      // If the config does not exist that is OK, we just skip this dir
      const targetConfig = path.resolve(targetDir, 'config.json');
      if (!fs.existsSync(targetConfig)) continue;

      const config = JSON.parse(fs.readFileSync(targetConfig, 'utf8'));
      for (const key of Object.keys(config)) {
        // The directory the config points to should exist
        const targetPatchesDir = path.resolve(__dirname, '../../..', key);
        if (!fs.existsSync(targetPatchesDir)) throw new Error(`target patch directory: "${targetPatchesDir}" does not exist`);
        // We need a .patches file
        const dotPatchesPath = path.resolve(targetPatchesDir, '.patches');
        if (!fs.existsSync(dotPatchesPath)) throw new Error(`.patches file: "${dotPatchesPath}" does not exist`);

        // Read the patch list
        const patchFileList = fs.readFileSync(dotPatchesPath, 'utf8').trim().split('\n');
        const patchFileSet = new Set(patchFileList);
        patchFileList.reduce((seen, file) => {
          if (seen.has(file)) {
            throw new Error(`'${file}' is listed in ${dotPatchesPath} more than once`);
          }
          return seen.add(file);
        }, new Set());
        if (patchFileList.length !== patchFileSet.size) throw new Error('each patch file should only be in the .patches file once');
        for (const file of fs.readdirSync(targetPatchesDir)) {
          // Ignore the .patches file and READMEs
          if (file === '.patches' || file === 'README.md') continue;

          if (!patchFileSet.has(file)) {
            throw new Error(`Expected the .patches file at "${dotPatchesPath}" to contain a patch file ("${file}") present in the directory but it did not`);
          }
          patchFileSet.delete(file);
        }

        // If anything is left in this set, it means it did not exist on disk
        if (patchFileSet.size > 0) {
          throw new Error(`Expected all the patch files listed in the .patches file at "${dotPatchesPath}" to exist but some did not:\n${JSON.stringify([...patchFileSet.values()], null, 2)}`);
        }
      }
    }

    let ok = true;
    filenames.filter(f => f.endsWith('.patch')).forEach(f => {
      const patchText = fs.readFileSync(f, 'utf8');
      if (/^Subject: .*$\s+^diff/m.test(patchText)) {
        console.warn(`Patch file '${f}' has no description. Every patch must contain a justification for why the patch exists and the plan for its removal.`);
        ok = false;
      }
      const trailingWhitespace = patchText.split('\n').filter(line => line.startsWith('+')).some(line => /\s+$/.test(line));
      if (trailingWhitespace) {
        console.warn(`Patch file '${f}' has trailing whitespace on some lines.`);
        ok = false;
      }
    });
    if (!ok) {
      process.exit(1);
    }
  }
}];

function parseCommandLine () {
  let help;
  const opts = minimist(process.argv.slice(2), {
    boolean: ['c++', 'objc', 'javascript', 'python', 'gn', 'patches', 'help', 'changed', 'fix', 'verbose', 'only'],
    alias: { 'c++': ['cc', 'cpp', 'cxx'], javascript: ['js', 'es'], python: 'py', changed: 'c', help: 'h', verbose: 'v' },
    unknown: arg => { help = true; }
  });
  if (help || opts.help) {
    console.log('Usage: script/lint.js [--cc] [--js] [--py] [-c|--changed] [-h|--help] [-v|--verbose] [--fix] [--only -- file1 file2]');
    process.exit(0);
  }
  return opts;
}

async function findChangedFiles (top) {
  const result = await GitProcess.exec(['diff', '--name-only', '--cached'], top);
  if (result.exitCode !== 0) {
    console.log('Failed to find changed files', GitProcess.parseError(result.stderr));
    process.exit(1);
  }
  const relativePaths = result.stdout.split(/\r\n|\r|\n/g);
  const absolutePaths = relativePaths.map(x => path.join(top, x));
  return new Set(absolutePaths);
}

async function findMatchingFiles (top, test) {
  return new Promise((resolve, reject) => {
    const matches = [];
    klaw(top, {
      filter: f => path.basename(f) !== '.bin'
    })
      .on('end', () => resolve(matches))
      .on('data', item => {
        if (test(item.path)) {
          matches.push(item.path);
        }
      });
  });
}

async function findFiles (args, linter) {
  let filenames = [];
  let includelist = null;

  // build the includelist
  if (args.changed) {
    includelist = await findChangedFiles(SOURCE_ROOT);
    if (!includelist.size) {
      return [];
    }
  } else if (args.only) {
    includelist = new Set(args._.map(p => path.resolve(p)));
  }

  // accumulate the raw list of files
  for (const root of linter.roots) {
    const files = await findMatchingFiles(path.join(SOURCE_ROOT, root), linter.test);
    filenames.push(...files);
  }

  for (const ignoreRoot of (linter.ignoreRoots) || []) {
    const ignorePath = path.join(SOURCE_ROOT, ignoreRoot);
    if (!fs.existsSync(ignorePath)) continue;

    const ignoreFiles = new Set(await findMatchingFiles(ignorePath, linter.test));
    filenames = filenames.filter(fileName => !ignoreFiles.has(fileName));
  }

  // remove ignored files
  filenames = filenames.filter(x => !IGNORELIST.has(x));

  // if a includelist exists, remove anything not in it
  if (includelist) {
    filenames = filenames.filter(x => includelist.has(x));
  }

  // it's important that filenames be relative otherwise clang-format will
  // produce patches with absolute paths in them, which `git apply` will refuse
  // to apply.
  return filenames.map(x => path.relative(SOURCE_ROOT, x));
}

async function main () {
  const opts = parseCommandLine();

  // no mode specified? run 'em all
  if (!opts['c++'] && !opts.javascript && !opts.objc && !opts.python && !opts.gn && !opts.patches) {
    opts['c++'] = opts.javascript = opts.objc = opts.python = opts.gn = opts.patches = true;
  }

  const linters = LINTERS.filter(x => opts[x.key]);

  for (const linter of linters) {
    const filenames = await findFiles(opts, linter);
    if (filenames.length) {
      if (opts.verbose) { console.log(`linting ${filenames.length} ${linter.key} ${filenames.length === 1 ? 'file' : 'files'}`); }
      linter.run(opts, filenames);
    }
  }
}

if (process.mainModule === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
