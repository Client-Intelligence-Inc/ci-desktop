#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAutomationTool } = require('../dist/tools/automation');
const { runAppTool } = require('../dist/tools/apps');
const { runFileTool } = require('../dist/tools/files');
const { runInputTool } = require('../dist/tools/input');
const { runSecretTool } = require('../dist/tools/secrets');
const { runShellTool } = require('../dist/tools/shell');
const { runSystemTool } = require('../dist/tools/system');

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-desktop-tools-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-desktop-outside-'));

  try {
    const settings = {
      displayName: 'Verifier',
      launchAtLogin: false,
      enabled: false,
      deviceId: 'verify-device',
      ownerUserId: 'verify-user',
      gatewayUrl: 'ws://127.0.0.1:1',
      fileAccessMode: 'selected_folders',
      allowedFolders: [root],
      controlMode: 'disabled',
      approvalMode: 'ask_every_time',
      allowShell: false,
      deviceApprovalGrants: [],
    };

    const appsList = await runAppTool({
      jobId: 'verify_apps_list',
      tool: 'apps.list',
      args: {},
    }, settings);
    assert(appsList.ok, `apps.list should succeed: ${appsList.error || ''}`);
    assert(Array.isArray(appsList.result.apps), 'apps.list should return apps array');

    const appQuitDisabled = await runAppTool({
      jobId: 'verify_apps_quit_disabled',
      tool: 'apps.quit',
      args: { pid: 1 },
    }, settings);
    assert(!appQuitDisabled.ok, 'apps.quit should require app control mode');

    const appOpenFilePathDenied = await runAppTool({
      jobId: 'verify_apps_open_file_path_denied',
      tool: 'apps.open',
      args: { path: path.join(root, 'not-an-app.txt') },
    }, {
      ...settings,
      controlMode: 'open_apps',
    });
    assert(
      !appOpenFilePathDenied.ok &&
      appOpenFilePathDenied.error.includes('.app bundle'),
      'apps.open path should reject non-app bundle paths',
    );

    const appActivateFilePathDenied = await runAppTool({
      jobId: 'verify_apps_activate_file_path_denied',
      tool: 'apps.activate',
      args: { path: path.join(root, 'not-an-app.txt') },
    }, {
      ...settings,
      controlMode: 'open_apps',
    });
    assert(
      !appActivateFilePathDenied.ok &&
      appActivateFilePathDenied.error.includes('.app bundle'),
      'apps.activate path should reject non-app bundle paths',
    );

    const dragDisabled = await runInputTool({
      jobId: 'verify_input_drag_disabled',
      tool: 'input.drag',
      args: { fromX: 10, fromY: 20, toX: 30, toY: 40 },
    }, settings);
    assert(!dragDisabled.ok, 'input.drag should require keyboard/mouse control mode');

    const scrollDisabled = await runInputTool({
      jobId: 'verify_input_scroll_disabled',
      tool: 'input.scroll',
      args: { deltaY: -500 },
    }, settings);
    assert(!scrollDisabled.ok, 'input.scroll should require keyboard/mouse control mode');

    const inputEnabledSettings = {
      ...settings,
      controlMode: 'keyboard_mouse',
    };
    const badClickButton = await runInputTool({
      jobId: 'verify_input_bad_click_button',
      tool: 'input.click',
      args: { x: 10, y: 20, button: 'side-button' },
    }, inputEnabledSettings);
    assert(
      !badClickButton.ok &&
      badClickButton.error.includes('Unsupported mouse button'),
      'input.click should return a structured failure for unsupported mouse buttons',
    );

    const badHotkeyModifier = await runInputTool({
      jobId: 'verify_input_bad_hotkey_modifier',
      tool: 'input.hotkey',
      args: { key: 'l', modifiers: ['hyper'] },
    }, inputEnabledSettings);
    assert(
      !badHotkeyModifier.ok &&
      badHotkeyModifier.error.includes('Unsupported modifier'),
      'input.hotkey should return a structured failure for unsupported modifiers',
    );

    const badPressKey = await runInputTool({
      jobId: 'verify_input_bad_press_key',
      tool: 'input.press_key',
      args: { key: 'launchpad' },
    }, inputEnabledSettings);
    assert(
      !badPressKey.ok &&
      badPressKey.error.includes('Unsupported key'),
      'input.press_key should return a structured failure for unsupported keys',
    );

    const systemInfo = await runSystemTool({
      jobId: 'verify_system_info',
      tool: 'system.info',
      args: {},
    }, settings);
    assert(systemInfo.ok, `system.info should succeed: ${systemInfo.error || ''}`);
    assert(systemInfo.result.memory.totalBytes > 0, 'system.info should report total memory');

    const systemStorage = await runSystemTool({
      jobId: 'verify_system_storage',
      tool: 'system.storage',
      args: { path: root },
    }, settings);
    assert(systemStorage.ok, `system.storage should succeed: ${systemStorage.error || ''}`);
    assert(systemStorage.result.volumes.length >= 1, 'system.storage should report at least one volume');

    const systemNetwork = await runSystemTool({
      jobId: 'verify_system_network',
      tool: 'system.network',
      args: { includeInternal: true },
    }, settings);
    assert(systemNetwork.ok, `system.network should succeed: ${systemNetwork.error || ''}`);
    assert(Array.isArray(systemNetwork.result.addresses), 'system.network should return addresses array');

    const write = await runFileTool({
      jobId: 'verify_write',
      tool: 'files.write',
      args: {
        path: path.join(root, 'notes', 'proposal.txt'),
        content: 'client intelligence proposal',
      },
    }, settings);
    assert(write.ok, `write should succeed: ${write.error || ''}`);

    const list = await runFileTool({
      jobId: 'verify_list',
      tool: 'files.list',
      args: { path: path.join(root, 'notes') },
    }, settings);
    assert(list.ok, `list should succeed: ${list.error || ''}`);
    assert(
      list.result.entries.some((entry) => entry.name === 'proposal.txt'),
      'list should include written file',
    );

    const read = await runFileTool({
      jobId: 'verify_read',
      tool: 'files.read',
      args: { path: path.join(root, 'notes', 'proposal.txt') },
    }, settings);
    assert(read.ok, `read should succeed: ${read.error || ''}`);
    assert(read.result.content === 'client intelligence proposal', 'read should return file content');

    const logPath = path.join(root, 'notes', 'activity.log');
    fs.writeFileSync(logPath, ['first', 'second', 'third', 'fourth'].join('\n'));
    const tail = await runFileTool({
      jobId: 'verify_tail',
      tool: 'files.tail',
      args: { path: logPath, lines: 2 },
    }, settings);
    assert(tail.ok, `tail should succeed: ${tail.error || ''}`);
    assert(tail.result.content === 'third\nfourth', 'tail should return the requested trailing lines');
    assert(tail.result.lines === 2, 'tail should report requested line count');

    const stat = await runFileTool({
      jobId: 'verify_stat',
      tool: 'files.stat',
      args: { path: path.join(root, 'notes', 'proposal.txt') },
    }, settings);
    assert(stat.ok, `stat should succeed: ${stat.error || ''}`);
    assert(stat.result.type === 'file', 'stat should identify file');
    assert(stat.result.size === Buffer.byteLength('client intelligence proposal'), 'stat should report size');

    const binaryContent = Buffer.from([0, 1, 2, 3, 254, 255]);
    const binaryWrite = await runFileTool({
      jobId: 'verify_binary_write',
      tool: 'files.write_binary',
      args: {
        path: path.join(root, 'notes', 'payload.bin'),
        contentBase64: binaryContent.toString('base64'),
      },
    }, settings);
    assert(binaryWrite.ok, `binary write should succeed: ${binaryWrite.error || ''}`);

    const binaryRead = await runFileTool({
      jobId: 'verify_binary_read',
      tool: 'files.read_binary',
      args: { path: path.join(root, 'notes', 'payload.bin') },
    }, settings);
    assert(binaryRead.ok, `binary read should succeed: ${binaryRead.error || ''}`);
    assert(
      Buffer.from(binaryRead.result.contentBase64, 'base64').equals(binaryContent),
      'binary read should preserve bytes',
    );

    const search = await runFileTool({
      jobId: 'verify_search',
      tool: 'files.search',
      args: { path: root, query: 'proposal' },
    }, settings);
    assert(search.ok, `search should succeed: ${search.error || ''}`);
    assert(search.result.matches.length === 1, 'search should find proposal file');

    const mkdir = await runFileTool({
      jobId: 'verify_mkdir',
      tool: 'files.mkdir',
      args: { path: path.join(root, 'managed', 'nested') },
    }, settings);
    assert(mkdir.ok, `mkdir should succeed: ${mkdir.error || ''}`);
    assert(fs.existsSync(path.join(root, 'managed', 'nested')), 'mkdir should create nested folder');

    const copy = await runFileTool({
      jobId: 'verify_copy',
      tool: 'files.copy',
      args: {
        sourcePath: path.join(root, 'notes', 'proposal.txt'),
        destinationPath: path.join(root, 'managed', 'nested', 'proposal-copy.txt'),
      },
    }, settings);
    assert(copy.ok, `copy should succeed: ${copy.error || ''}`);
    assert(
      fs.readFileSync(path.join(root, 'managed', 'nested', 'proposal-copy.txt'), 'utf-8') === 'client intelligence proposal',
      'copy should preserve file content',
    );

    const move = await runFileTool({
      jobId: 'verify_move',
      tool: 'files.move',
      args: {
        sourcePath: path.join(root, 'managed', 'nested', 'proposal-copy.txt'),
        destinationPath: path.join(root, 'managed', 'proposal-moved.txt'),
      },
    }, settings);
    assert(move.ok, `move should succeed: ${move.error || ''}`);
    assert(fs.existsSync(path.join(root, 'managed', 'proposal-moved.txt')), 'move should create destination');
    assert(!fs.existsSync(path.join(root, 'managed', 'nested', 'proposal-copy.txt')), 'move should remove source');

    const deleteFile = await runFileTool({
      jobId: 'verify_delete_file',
      tool: 'files.delete',
      args: { path: path.join(root, 'managed', 'proposal-moved.txt') },
    }, settings);
    assert(deleteFile.ok, `delete file should succeed: ${deleteFile.error || ''}`);
    assert(!fs.existsSync(path.join(root, 'managed', 'proposal-moved.txt')), 'delete should remove file');

    const deleteDirectoryWithoutRecursive = await runFileTool({
      jobId: 'verify_delete_directory_denied',
      tool: 'files.delete',
      args: { path: path.join(root, 'managed') },
    }, settings);
    assert(!deleteDirectoryWithoutRecursive.ok, 'delete directory should require recursive flag');

    const deleteDirectory = await runFileTool({
      jobId: 'verify_delete_directory',
      tool: 'files.delete',
      args: { path: path.join(root, 'managed'), recursive: true },
    }, settings);
    assert(deleteDirectory.ok, `delete directory should succeed: ${deleteDirectory.error || ''}`);
    assert(!fs.existsSync(path.join(root, 'managed')), 'recursive delete should remove directory');

    const openDisabled = await runFileTool({
      jobId: 'verify_open_disabled',
      tool: 'files.open',
      args: { path: path.join(root, 'notes', 'proposal.txt') },
    }, settings);
    assert(!openDisabled.ok, 'file open should require app control mode');

    const revealDisabled = await runFileTool({
      jobId: 'verify_reveal_disabled',
      tool: 'files.reveal',
      args: { path: path.join(root, 'notes', 'proposal.txt') },
    }, settings);
    assert(!revealDisabled.ok, 'file reveal should require app control mode');

    const shellDisabled = await runShellTool({
      jobId: 'verify_shell_disabled',
      tool: 'shell.run',
      args: { command: '/bin/pwd' },
    }, settings);
    assert(!shellDisabled.ok, 'shell.run should require shell access to be enabled');

    const shellSettings = {
      ...settings,
      allowShell: true,
    };
    const shellDefaultCwd = await runShellTool({
      jobId: 'verify_shell_default_cwd',
      tool: 'shell.run',
      args: { command: '/bin/pwd' },
    }, shellSettings);
    assert(shellDefaultCwd.ok, `shell default cwd should succeed: ${shellDefaultCwd.error || ''}`);
    assert(
      fs.realpathSync(shellDefaultCwd.result.stdout.trim()) === fs.realpathSync(root),
      'shell.run should default to the first allowed folder when file access is scoped',
    );

    const shellBareSystemCommand = await runShellTool({
      jobId: 'verify_shell_bare_system_command',
      tool: 'shell.run',
      args: { command: 'pwd' },
    }, shellSettings);
    assert(shellBareSystemCommand.ok, `bare system shell command should succeed: ${shellBareSystemCommand.error || ''}`);
    assert(
      fs.realpathSync(shellBareSystemCommand.result.stdout.trim()) === fs.realpathSync(root),
      'shell.run should resolve bare command names only from system binary directories',
    );

    const shellScopedCwd = await runShellTool({
      jobId: 'verify_shell_scoped_cwd',
      tool: 'shell.run',
      args: { command: '/bin/pwd', cwd: path.join(root, 'notes') },
    }, shellSettings);
    assert(shellScopedCwd.ok, `shell scoped cwd should succeed: ${shellScopedCwd.error || ''}`);
    assert(
      fs.realpathSync(shellScopedCwd.result.stdout.trim()) === fs.realpathSync(path.join(root, 'notes')),
      'shell.run should accept cwd inside allowed folders',
    );

    let shellDenied = false;
    try {
      await runShellTool({
        jobId: 'verify_shell_denied_cwd',
        tool: 'shell.run',
        args: { command: '/bin/pwd', cwd: outside },
      }, shellSettings);
    } catch {
      shellDenied = true;
    }
    assert(shellDenied, 'shell.run should deny cwd outside allowed folders');

    const localCommandName = `ci-local-command-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const localCommandPath = path.join(root, localCommandName);
    fs.writeFileSync(localCommandPath, '#!/bin/sh\necho should-not-run\n');
    fs.chmodSync(localCommandPath, 0o755);

    let relativeCommandDenied = false;
    try {
      await runShellTool({
        jobId: 'verify_shell_relative_command_denied',
        tool: 'shell.run',
        args: { command: `./${localCommandName}`, cwd: root },
      }, shellSettings);
    } catch {
      relativeCommandDenied = true;
    }
    assert(relativeCommandDenied, 'shell.run should deny relative command paths');

    let bareLocalCommandDenied = false;
    try {
      await runShellTool({
        jobId: 'verify_shell_bare_local_command_denied',
        tool: 'shell.run',
        args: { command: localCommandName, cwd: root },
      }, shellSettings);
    } catch {
      bareLocalCommandDenied = true;
    }
    assert(bareLocalCommandDenied, 'shell.run should not resolve bare commands through cwd or PATH');

    let nonSystemAbsoluteCommandDenied = false;
    try {
      await runShellTool({
        jobId: 'verify_shell_non_system_absolute_command_denied',
        tool: 'shell.run',
        args: { command: localCommandPath, cwd: root },
      }, shellSettings);
    } catch {
      nonSystemAbsoluteCommandDenied = true;
    }
    assert(nonSystemAbsoluteCommandDenied, 'shell.run should deny absolute commands outside system binary directories');

    let invalidShellArgsDenied = false;
    try {
      await runShellTool({
        jobId: 'verify_shell_invalid_args_denied',
        tool: 'shell.run',
        args: { command: '/bin/pwd', args: ['ok', 1] },
      }, shellSettings);
    } catch {
      invalidShellArgsDenied = true;
    }
    assert(invalidShellArgsDenied, 'shell.run should require command args to be strings');

    if (process.platform !== 'win32') {
      const outsideSecretPath = path.join(outside, 'secret.txt');
      const symlinkPath = path.join(root, 'notes', 'outside-link');
      fs.writeFileSync(outsideSecretPath, 'outside secret');
      fs.symlinkSync(outsideSecretPath, symlinkPath);

      let symlinkDenied = false;
      try {
        await runFileTool({
          jobId: 'verify_symlink_denied',
          tool: 'files.read',
          args: { path: symlinkPath },
        }, settings);
      } catch {
        symlinkDenied = true;
      }
      assert(symlinkDenied, 'file tools should deny symlinks that escape allowed folders');
    }

    let denied = false;
    try {
      await runFileTool({
        jobId: 'verify_denied',
        tool: 'files.delete',
        args: { path: path.join(outside, 'blocked.txt') },
      }, settings);
    } catch {
      denied = true;
    }
    assert(denied, 'file management outside allowed folders should be denied');

    if (process.platform === 'darwin') {
      const screenToolSource = fs.readFileSync(path.join(process.cwd(), 'src/tools/screen.ts'), 'utf-8');
      assert(
        screenToolSource.includes("args?.sourceId ? ['screen', 'window'] : ['screen']"),
        'screen.screenshot should request window sources when a sourceId is provided',
      );
      assert(
        screenToolSource.includes('thumbnail.toJPEG(encoding.quality)'),
        'screen.screenshot should support JPEG encoding with quality control',
      );
      const browserToolSource = fs.readFileSync(path.join(process.cwd(), 'src/tools/browser.ts'), 'utf-8');
      assert(
        browserToolSource.includes('const KNOWN_BROWSERS') &&
        browserToolSource.includes("chrome: 'Google Chrome'") &&
        browserToolSource.includes("safari: 'Safari'"),
        'browser.open_url should constrain targeted browser names to known local browsers',
      );
      const appToolSource = fs.readFileSync(path.join(process.cwd(), 'src/tools/apps.ts'), 'utf-8');
      assert(
        appToolSource.includes('validateAppBundlePath') &&
        appToolSource.includes("'.app'"),
        'app path control should be constrained to .app bundles',
      );

      const automation = await runAutomationTool({
        jobId: 'verify_automation',
        tool: 'automation.applescript',
        args: { script: 'return "automation-ok"', timeoutMs: 5000 },
      }, {
        ...settings,
        controlMode: 'automation',
      });
      assert(automation.ok, `automation should succeed: ${automation.error || ''}`);
      assert(automation.result.stdout === 'automation-ok', 'automation should return stdout');

      const blockedSecret = await runAutomationTool({
        jobId: 'verify_automation_secret',
        tool: 'automation.applescript',
        args: { script: 'set password "secret"' },
      }, {
        ...settings,
        controlMode: 'automation',
      });
      assert(!blockedSecret.ok, 'automation should reject inline secret-looking script');

      const secretName = `verify-secret-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const savedSecret = await runSecretTool({
        jobId: 'verify_secret_save',
        tool: 'secrets.save',
        args: {
          name: secretName,
          secret: 'keychain-secret-value',
        },
      }, settings);
      assert(savedSecret.ok, `secret save should succeed: ${savedSecret.error || ''}`);
      assert(
        !JSON.stringify(savedSecret.result).includes('keychain-secret-value'),
        'secret save result should not include raw secret',
      );

      const existingSecret = await runSecretTool({
        jobId: 'verify_secret_exists',
        tool: 'secrets.exists',
        args: { name: secretName },
      }, settings);
      assert(existingSecret.ok, `secret exists should succeed: ${existingSecret.error || ''}`);
      assert(existingSecret.result.exists === true, 'saved secret should exist');

      const deletedSecret = await runSecretTool({
        jobId: 'verify_secret_delete',
        tool: 'secrets.delete',
        args: { name: secretName },
      }, settings);
      assert(deletedSecret.ok, `secret delete should succeed: ${deletedSecret.error || ''}`);

      const missingSecret = await runSecretTool({
        jobId: 'verify_secret_missing',
        tool: 'secrets.exists',
        args: { name: secretName },
      }, settings);
      assert(missingSecret.ok, `secret missing check should succeed: ${missingSecret.error || ''}`);
      assert(missingSecret.result.exists === false, 'deleted secret should not exist');
    }

    console.log('Local file tool verification passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
