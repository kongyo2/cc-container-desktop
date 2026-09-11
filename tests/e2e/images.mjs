// Download → verify → register → environment → task, against a local registry.
// Needs Docker and no API key. Builds the base image once (or reuses
// CC_E2E_BASE_IMAGE) and keeps a registry container running between runs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  call,
  check,
  errorCode,
  finish,
  goView,
  harnessFailure,
  imageByEntry,
  launchIsolated,
  ok,
  readContainerFile,
  sh,
  shoot,
  taskById,
  TASK_PREFIX,
  waitFor,
  waitForOperation,
  writeContainerFile,
} from './helpers.mjs';

function dockerLabelsOf(containerName) {
  const raw = execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', containerName], {
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function dockerImageIdOf(containerName) {
  return execFileSync('docker', ['inspect', '--format', '{{.Image}}', containerName], { encoding: 'utf8' }).trim();
}

function listVerifyContainers() {
  return execFileSync(
    'docker',
    ['ps', '-a', '--filter', 'label=com.cc-container-desktop.role=verify', '--format', '{{.Names}}'],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
}

let session = await launchIsolated();
let { page, fixture } = session;
const userData = session.userData;

try {
  console.log('\n[A] a fresh install: catalog visible, nothing registered, Images page first');
  let snapshot = await ok(page, 'snapshot');
  check('docker reachable', snapshot.docker.available === true, snapshot.docker.error ?? snapshot.docker.version);
  check(
    'the daemon platform is normalized',
    snapshot.docker.platform === fixture.platform,
    String(snapshot.docker.platform),
  );
  check(
    'config is the state-v1 shape with an instance id',
    snapshot.config.schemaVersion === 1 && /^inst_/u.test(snapshot.config.dataInstanceId),
  );
  check(
    'the state lives under state-v1',
    snapshot.dataDir.endsWith('state-v1') && existsSync(join(userData, 'state-v1', 'config.json')),
  );
  check(
    'no environment is seeded',
    snapshot.config.environments.length === 0 && snapshot.config.defaultEnvironmentId === null,
  );
  check('nothing is registered', snapshot.images.length === 0);
  check(
    'the catalog holds both fixture releases',
    snapshot.catalog.entries.length === 2 && snapshot.catalog.repository === fixture.repository,
  );
  check('exactly one entry is recommended', snapshot.catalog.entries.filter((entry) => entry.recommended).length === 1);
  check(
    'no store problems on a fresh install',
    snapshot.storeProblems.length === 0,
    JSON.stringify(snapshot.storeProblems),
  );
  const activeView = await page.evaluate(
    () => document.querySelector('.sidebar-nav button.active')?.dataset.view ?? '',
  );
  check('the app opens on the Images page when nothing exists yet', activeView === 'images', activeView);
  const cards = await page.evaluate(() => document.querySelectorAll('[data-testid="image-card"]').length);
  check('both catalog entries render as cards', cards === 2, String(cards));
  const dockerState = await page.evaluate(
    () => document.querySelector('[data-testid="images-docker-state"]')?.textContent ?? '',
  );
  check('the Docker state line names the platform', dockerState.includes(fixture.platform), dockerState);
  await shoot(page, 'images-01-fresh');

  console.log('\n[B] input validation and structured errors');
  const unknownEntry = await call(page, 'imageDownloadStart', [{ catalogEntryId: 'ghost@2026.01.1' }]);
  check(
    'an unknown catalog id is refused with INVALID_INPUT',
    errorCode(unknownEntry) === 'INVALID_INPUT',
    errorCode(unknownEntry),
  );
  const noArgs = await call(page, 'imageDownloadStart', [{}]);
  check('a payload without an id is refused', errorCode(noArgs) === 'INVALID_INPUT');
  const extraArgs = await call(page, 'imageDownloadStart', [
    { catalogEntryId: fixture.releaseOne.id, repository: 'evil.test/x' },
  ]);
  check('a payload with a repository override is refused', errorCode(extraArgs) === 'INVALID_INPUT');
  const cancelGhost = await call(page, 'imageCancel', [{ operationId: 'op_nope' }]);
  check('cancelling an unknown operation is OPERATION_NOT_FOUND', errorCode(cancelGhost) === 'OPERATION_NOT_FOUND');
  const repairGhost = await call(page, 'imageRepairStart', [{ imageId: 'img_000000000000000000000000' }]);
  check('repairing an unregistered image is IMAGE_NOT_REGISTERED', errorCode(repairGhost) === 'IMAGE_NOT_REGISTERED');
  const envNoImage = await call(page, 'environmentUpsert', [
    { id: 'e', name: 'x', imageId: '', envText: '', setupScript: '' },
  ]);
  check('an environment without an image is refused', errorCode(envNoImage) === 'INVALID_INPUT');
  const envGhostImage = await call(page, 'environmentUpsert', [
    { id: 'e', name: 'x', imageId: 'img_000000000000000000000000', envText: '', setupScript: '' },
  ]);
  check('an environment naming an unregistered image is refused', errorCode(envGhostImage) === 'IMAGE_NOT_REGISTERED');
  const taskNoEnv = await call(page, 'taskCreate', [
    { name: 'x', note: '', profileId: null, environmentId: '', source: { kind: 'empty' } },
  ]);
  check(
    'a task without an environment is refused',
    errorCode(taskNoEnv) === 'ENVIRONMENT_MISSING',
    errorCode(taskNoEnv),
  );
  const legacyKey = await call(page, 'configSave', [{ imageTag: 'x' }]);
  check('the removed imageTag setting is rejected', legacyKey.ok === false);

  console.log('\n[C] download and register release one');
  await page.evaluate(() => {
    window.__ccOps = [];
    window.cc.onImageOperation((operation) => window.__ccOps.push(operation));
  });
  const first = await ok(page, 'imageDownloadStart', [{ catalogEntryId: fixture.releaseOne.id }]);
  const second = await ok(page, 'imageDownloadStart', [{ catalogEntryId: fixture.releaseOne.id }]);
  check(
    'a second click on the same card returns the same operation',
    first.id === second.id,
    `${first.id} / ${second.id}`,
  );
  check('the operation starts queued with a sequence of 0', first.phase === 'queued' && first.sequence === 0);
  const badge = await waitFor(
    page,
    () => page.evaluate(() => document.querySelector('[data-testid="images-nav-badge"]')?.textContent ?? ''),
    (text) => text === '1',
    10_000,
  );
  check('the sidebar shows one active download', badge === '1', badge);
  const done = await waitForOperation(page, first.id);
  check('the download succeeded', done.phase === 'succeeded', done.error?.message ?? done.phase);
  check(
    'the operation pinned the digest and platform it resolved',
    done.target.pinnedDigest === fixture.releaseOne.digest && done.target.platform === fixture.platform,
  );
  check('the operation records that a network pull happened', done.pulled === true);
  check(
    'the operation names the registration it produced',
    typeof done.registeredImageId === 'string' && /^img_/u.test(done.registeredImageId),
  );
  const events = await page.evaluate(() => window.__ccOps);
  const phases = [...new Set(events.filter((event) => event.id === first.id).map((event) => event.phase))];
  check(
    'progress events arrived in phase order',
    ['checking', 'pulling', 'verifying', 'registering', 'succeeded'].every((phase) => phases.includes(phase)),
    phases.join(' → '),
  );
  const sequences = events.filter((event) => event.id === first.id).map((event) => event.sequence);
  check(
    'sequences never go backwards',
    sequences.every((value, index) => index === 0 || value >= sequences[index - 1]),
  );
  check(
    'no verification container is left behind',
    listVerifyContainers().length === 0,
    listVerifyContainers().join(','),
  );

  snapshot = await ok(page, 'snapshot');
  const registeredOne = imageByEntry(snapshot, fixture.releaseOne.id);
  check('the image is registered', registeredOne !== null);
  check(
    'and available on this daemon',
    registeredOne?.availability.kind === 'ready',
    JSON.stringify(registeredOne?.availability),
  );
  check(
    'the registration pins the manifest digest',
    registeredOne?.image.pinnedDigest === fixture.releaseOne.digest && registeredOne?.image.digestKind === 'manifest',
  );
  check(
    'the registration carries the engine id it was verified on',
    registeredOne?.image.lastVerified.engineId === snapshot.docker.engineId,
  );
  check(
    'the runtime contract passed a meaningful number of checks',
    (registeredOne?.image.lastVerified.checksPassed ?? 0) >= 25,
    String(registeredOne?.image.lastVerified.checksPassed),
  );
  check(
    'tool versions were measured from the image',
    registeredOne?.image.tools.find((tool) => tool.id === 'node')?.version.startsWith('24.') === true,
    JSON.stringify(registeredOne?.image.tools),
  );
  const ledger = JSON.parse(readFileSync(join(userData, 'state-v1', 'images.json'), 'utf8'));
  check('the ledger on disk holds exactly one registration', ledger.schemaVersion === 1 && ledger.images.length === 1);
  const history = JSON.parse(readFileSync(join(userData, 'state-v1', 'image-operations.json'), 'utf8'));
  check(
    'the operation history is persisted without layer detail',
    history.operations.some((operation) => operation.id === first.id && operation.layers.length === 0),
  );
  await goView(page, 'images');
  const cardState = await page.evaluate(
    (entryId) => document.querySelector(`[data-testid="image-card"][data-entry-id="${entryId}"]`)?.className ?? '',
    fixture.releaseOne.id,
  );
  check('the card shows as registered', cardState.includes('registered'), cardState);
  await shoot(page, 'images-02-registered');

  console.log('\n[D] the same content registers once; a queued download can be cancelled');
  const again = await ok(page, 'imageDownloadStart', [{ catalogEntryId: fixture.releaseOne.id }]);
  const queued = await ok(page, 'imageDownloadStart', [{ catalogEntryId: fixture.releaseTwo.id }]);
  const cancelled = await ok(page, 'imageCancel', [{ operationId: queued.id }]);
  check('cancel is accepted on a queued operation', cancelled.cancelRequested === true);
  const againDone = await waitForOperation(page, again.id);
  check(
    're-downloading registered content succeeds by local verification',
    againDone.phase === 'succeeded' && againDone.pulled === false,
    `${againDone.phase} pulled=${againDone.pulled}`,
  );
  const queuedDone = await waitForOperation(page, queued.id);
  check(
    'the cancelled operation ends cancelled without an error',
    queuedDone.phase === 'cancelled' && queuedDone.error === null,
    queuedDone.phase,
  );
  snapshot = await ok(page, 'snapshot');
  check('still exactly one registration', snapshot.images.length === 1);
  check('the registration id is stable across re-downloads', againDone.registeredImageId === done.registeredImageId);
  check(
    'release two was not registered by the cancelled operation',
    imageByEntry(snapshot, fixture.releaseTwo.id) === null,
  );

  console.log('\n[E] an environment needs the image; a task runs on it');
  const environmentId = 'e2e-env';
  const savedEnv = await ok(page, 'environmentUpsert', [
    {
      id: environmentId,
      name: 'E2E env',
      imageId: done.registeredImageId,
      envText: 'CC_E2E=1',
      setupScript: 'echo setup > ~/workspace/setup.txt',
    },
  ]);
  check('the first environment becomes the default', savedEnv.defaultEnvironmentId === environmentId);
  check('the environment references the image', savedEnv.environments[0]?.imageId === done.registeredImageId);
  snapshot = await ok(page, 'snapshot');
  check(
    'the registered image lists the environment',
    imageByEntry(snapshot, fixture.releaseOne.id)?.environmentIds.includes(environmentId) === true,
  );

  const inUseByEnv = await call(page, 'imageUnregister', [{ imageId: done.registeredImageId }]);
  check(
    'an image used by an environment cannot be unregistered',
    errorCode(inUseByEnv) === 'IMAGE_IN_USE',
    errorCode(inUseByEnv),
  );

  const created = await session.createTask({ name: `${TASK_PREFIX}images`, environmentId });
  const task = created.task;
  check('the task was created without warnings', created.warning === null, created.warning ?? '');
  check(
    'the task records what was applied',
    task.lastAppliedRuntime?.registeredImageId === done.registeredImageId &&
      task.lastAppliedRuntime?.environmentId === environmentId,
  );
  snapshot = await ok(page, 'snapshot');
  let view = taskById(snapshot, task.id);
  check('the container is running', view?.container.running === true);
  check(
    'the container reports the registered image it was created from',
    view?.container.registeredImageId === done.registeredImageId &&
      view?.container.pinnedDigest === fixture.releaseOne.digest,
  );
  check(
    'nothing is stale',
    view?.imageStale === false && view?.environmentStale === false,
    JSON.stringify({ image: view?.imageStale, env: view?.environmentStale }),
  );
  const labels = dockerLabelsOf(task.containerName);
  check(
    'the container is labelled with instance, image and digest',
    labels['com.cc-container-desktop.instance'] === snapshot.config.dataInstanceId &&
      labels['com.cc-container-desktop.image'] === done.registeredImageId &&
      labels['com.cc-container-desktop.image-digest'] === fixture.releaseOne.digest &&
      labels['com.cc-container-desktop.runtime-contract'] === '1',
    JSON.stringify(labels),
  );
  const info = JSON.parse(await readContainerFile(page, task.id, '/opt/cc/image-info.json'));
  check('the container runs the registered release', info.release === '2026.09.1' && info.variant === 'base');
  check('the environment variable is set', (await sh(page, task.id, 'printf %s "$CC_E2E"')).stdout === '1');
  check(
    'the setup script ran',
    (await readContainerFile(page, task.id, '/home/claude/workspace/setup.txt')) === 'setup\n',
  );
  const claude = await sh(page, task.id, 'claude --version');
  check('Claude Code answers inside the task', claude.exitCode === 0, claude.stdout.trim().slice(0, 60));
  const inUseByTask = await call(page, 'imageUnregister', [{ imageId: done.registeredImageId }]);
  check('an image a task was applied from cannot be unregistered', errorCode(inUseByTask) === 'IMAGE_IN_USE');
  await writeContainerFile(page, task.id, '/home/claude/workspace/keep-me.txt', 'kept\n');
  await shoot(page, 'images-03-task');

  console.log('\n[F] a second release: registered, switched, applied by recreate');
  const two = await session.registerImage(fixture.releaseTwo.id);
  check(
    'release two is registered as a different image',
    two.image.id !== done.registeredImageId && two.image.pinnedDigest === fixture.releaseTwo.digest,
  );
  snapshot = await ok(page, 'snapshot');
  view = taskById(snapshot, task.id);
  check(
    'registering a new release changes nothing for the existing task',
    view?.imageStale === false && view?.desiredImageId === done.registeredImageId,
  );

  await ok(page, 'environmentUpsert', [
    {
      id: environmentId,
      name: 'E2E env',
      imageId: two.image.id,
      envText: 'CC_E2E=1',
      setupScript: 'echo setup > ~/workspace/setup.txt',
    },
  ]);
  snapshot = await ok(page, 'snapshot');
  view = taskById(snapshot, task.id);
  check(
    'switching the environment image flags the task',
    view?.imageStale === true && view?.environmentStale === false,
    JSON.stringify({ image: view?.imageStale, env: view?.environmentStale }),
  );
  check(
    'the desired image and its availability are exposed',
    view?.desiredImageId === two.image.id && view?.desiredAvailability?.kind === 'ready',
  );
  check('the applied image is still release one', view?.appliedImageId === done.registeredImageId);
  await page.click(`.task-item[data-task-id="${task.id}"]`);
  await page.waitForTimeout(400);
  const staleTag = await page.evaluate(() => document.querySelector('[data-testid="image-stale"]')?.textContent ?? '');
  check('the task page shows the pending image change', staleTag !== '', staleTag);
  await shoot(page, 'images-04-stale');

  const beforeRecreate = dockerImageIdOf(task.containerName);
  await ok(page, 'taskRecreate', [task.id]);
  snapshot = await ok(page, 'snapshot');
  view = taskById(snapshot, task.id);
  check('recreate clears the flag', view?.imageStale === false);
  check(
    'the container now runs release two',
    dockerImageIdOf(task.containerName) !== beforeRecreate && view?.container.registeredImageId === two.image.id,
  );
  check(
    'release two is really inside',
    (await sh(page, task.id, 'cat /opt/cc/e2e-release-two')).stdout.trim() === 'release two',
  );
  check(
    'the home volume survived',
    (await readContainerFile(page, task.id, '/home/claude/workspace/keep-me.txt')) === 'kept\n',
  );
  check(
    'the task remembers the new applied runtime',
    view?.task.lastAppliedRuntime?.registeredImageId === two.image.id,
  );
  snapshot = await ok(page, 'snapshot');
  check(
    'release one is no longer applied to any task',
    imageByEntry(snapshot, fixture.releaseOne.id)?.appliedTaskIds.length === 0,
  );
  const stillUsed = await call(page, 'imageUnregister', [{ imageId: done.registeredImageId }]);
  check(
    'release one is still protected by the environment history? no — only by references; none left, so it can go',
    stillUsed.ok === true,
    errorCode(stillUsed),
  );
  snapshot = await ok(page, 'snapshot');
  check(
    'unregistering removes only the ledger entry',
    snapshot.images.length === 1 && snapshot.images[0]?.image.id === two.image.id,
  );
  check(
    'the image itself stays in Docker',
    execFileSync('docker', ['image', 'inspect', fixture.releaseOne.localTag], { stdio: 'pipe' }).length > 0,
  );

  console.log('\n[G] restart: registrations, history and the running task persist; legacy files are ignored');
  writeFileSync(
    join(userData, 'config.json'),
    JSON.stringify({ version: 3, imageTag: 'legacy:latest', environments: [{ id: 'legacy' }] }),
  );
  writeFileSync(
    join(userData, 'tasks.json'),
    JSON.stringify({ version: 1, tasks: [{ id: 'legacy1', name: 'legacy' }] }),
  );
  // The session's close() deletes the tasks it created; this one must outlive the restart.
  session.forgetTask(task.id);
  await session.close({ keepUserData: true });
  session = await launchIsolated({ userData });
  ({ page } = session);
  session.created.set(task.id, task);
  snapshot = await ok(page, 'snapshot');
  check(
    'the registration survived the restart',
    snapshot.images.length === 1 && snapshot.images[0]?.image.id === two.image.id,
  );
  check('the environment survived the restart', snapshot.config.environments.length === 1);
  view = taskById(snapshot, task.id);
  check(
    'the task survived and its container is still running',
    snapshot.tasks.length === 1 && view?.container.running === true,
    JSON.stringify({ tasks: snapshot.tasks.length, running: view?.container.running }),
  );
  check(
    'the restarted app still knows what the container runs',
    view?.container.registeredImageId === two.image.id && view?.imageStale === false,
  );
  check(
    'legacy files next to state-v1 are not read',
    snapshot.config.environments[0]?.id === environmentId &&
      !snapshot.tasks.some((candidate) => candidate.task.id === 'legacy1'),
  );
  check(
    'finished operations are still listed and none is running',
    snapshot.operations.length >= 3 &&
      snapshot.operations.every((operation) => operation.phase !== 'pulling' && operation.phase !== 'queued'),
  );
  const activeAfterRestart = await page.evaluate(
    () => document.querySelector('.sidebar-nav button.active')?.dataset.view ?? '',
  );
  check('with data present the app opens on the tasks page', activeAfterRestart !== 'images', activeAfterRestart);

  console.log('\n[H] a registration whose image disappears is repaired by digest');
  await ok(page, 'taskDelete', [task.id, { exportFirst: false }]);
  session.forgetTask(task.id);
  fixture.forgetPulled(fixture.releaseTwo.digest);
  snapshot = await ok(page, 'snapshot');
  const missingTwo = imageByEntry(snapshot, fixture.releaseTwo.id);
  check(
    'the registration stays and reads as missing',
    missingTwo?.availability.kind === 'missing',
    JSON.stringify(missingTwo?.availability),
  );
  check(
    'the environment keeps pointing at it',
    snapshot.config.environments[0]?.imageId === two.image.id && missingTwo?.environmentIds.includes(environmentId),
  );
  const onMissing = await call(page, 'taskCreate', [
    { name: `${TASK_PREFIX}missing`, note: '', profileId: null, environmentId, source: { kind: 'empty' } },
  ]);
  check(
    'a task cannot be created on a missing image',
    errorCode(onMissing) === 'IMAGE_UNAVAILABLE',
    errorCode(onMissing) || 'created',
  );
  if (onMissing.ok) session.created.set(onMissing.value.task.id, onMissing.value.task);
  await goView(page, 'images');
  const repairButton = await page.evaluate(
    () => document.querySelectorAll('[data-testid="image-repair"], [data-testid="registered-image-repair"]').length,
  );
  check('the Images page offers a re-download', repairButton > 0, String(repairButton));
  await shoot(page, 'images-05-missing');
  const repair = await ok(page, 'imageRepairStart', [{ imageId: two.image.id }]);
  const repaired = await waitForOperation(page, repair.id);
  check(
    'repair pulls the same digest again',
    repaired.phase === 'succeeded' && repaired.pulled === true && repaired.kind === 'repair',
    `${repaired.phase} pulled=${repaired.pulled} ${repaired.error?.message ?? ''}`,
  );
  snapshot = await ok(page, 'snapshot');
  check(
    'the same registration id is ready again',
    snapshot.images.length === 1 &&
      snapshot.images[0]?.image.id === two.image.id &&
      imageByEntry(snapshot, fixture.releaseTwo.id)?.availability.kind === 'ready',
    JSON.stringify(imageByEntry(snapshot, fixture.releaseTwo.id)?.availability),
  );
  const afterRepair = await session.createTask({ name: `${TASK_PREFIX}repaired`, environmentId });
  check(
    'a task starts on the repaired image',
    taskById(await ok(page, 'snapshot'), afterRepair.task.id)?.container.running === true,
  );
  check(
    'and it really is release two',
    (await sh(page, afterRepair.task.id, 'cat /opt/cc/e2e-release-two')).stdout.trim() === 'release two',
  );
  await ok(page, 'taskDelete', [afterRepair.task.id, { exportFirst: false }]);
  session.forgetTask(afterRepair.task.id);

  console.log('\n[I] a broken ledger blocks registration instead of being overwritten');
  await ok(page, 'environmentArchive', [environmentId, true]);
  await ok(page, 'environmentDelete', [environmentId]);
  await ok(page, 'imageUnregister', [{ imageId: two.image.id }]);
  await session.close({ keepUserData: true });
  const ledgerPath = join(userData, 'state-v1', 'images.json');
  writeFileSync(ledgerPath, '{ "schemaVersion": 1, "images": [ { "broken": true } ] }');
  session = await launchIsolated({ userData });
  ({ page } = session);
  snapshot = await ok(page, 'snapshot');
  check(
    'the broken ledger is reported',
    snapshot.storeProblems.some((problem) => problem.includes('images.json')),
    JSON.stringify(snapshot.storeProblems),
  );
  const problemsBanner = await page.evaluate(() => document.querySelector('[data-testid="store-problems"]') !== null);
  check('and shown in the UI', problemsBanner);
  const blocked = await ok(page, 'imageDownloadStart', [{ catalogEntryId: fixture.releaseTwo.id }]);
  const blockedDone = await waitForOperation(page, blocked.id);
  check(
    'the download fails at registration',
    blockedDone.phase === 'failed' && blockedDone.error?.code === 'STORE_UNWRITABLE',
    `${blockedDone.phase} ${blockedDone.error?.code ?? ''}`,
  );
  check('the broken file was not overwritten', readFileSync(ledgerPath, 'utf8').includes('"broken": true'));
  check('nothing is reported as registered', (await ok(page, 'snapshot')).images.length === 0);
  const kept = execFileSync('ls', [join(userData, 'state-v1')], { encoding: 'utf8' });
  check(
    'a copy of the unreadable file was kept aside',
    /images\.json\.broken-/u.test(kept),
    kept.trim().split('\n').join(' '),
  );
  mkdirSync(join(userData, 'state-v1'), { recursive: true });
} catch (error) {
  harnessFailure(error);
} finally {
  await session.close();
}

finish();
