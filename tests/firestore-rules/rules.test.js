import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';

const projectTypes = {
  egg: 'תרומת ביצית - קפריסין',
  surrogacy: 'פונדקאות - גאורגיה',
  surrogacyEgg: 'פונדקאות + תרומת ביצית - גאורגיה'
};
const testProjectId = 'demo-ttl-crm-rules';
let testEnvironment;

function authenticatedDb(uid) {
  return testEnvironment.authenticatedContext(uid, {
    email_mfa_verified: true,
    firebase: { sign_in_provider: 'custom' }
  }).firestore();
}

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId: testProjectId,
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8')
    }
  });
});

after(async () => {
  await testEnvironment.cleanup();
});

beforeEach(async () => {
  await testEnvironment.clearFirestore();
  await testEnvironment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const users = [
      ['egg-staff', { role: 'Staff_Egg', is_active: true, can_view_agreements: false }],
      ['egg-agreement-staff', { role: 'Staff_Egg', is_active: true, can_view_agreements: true }],
      ['sur-staff', { role: 'Staff_Sur', is_active: true, can_view_agreements: false }],
      ['all-staff', { role: 'Staff_All', is_active: true, can_view_agreements: false }],
      ['admin', { role: 'Admin', is_active: true, can_view_agreements: false }]
    ];
    for (const [uid, profile] of users) {
      await setDoc(doc(db, 'users', uid), profile);
    }

    const projects = [
      ['egg-assigned', {
        project_type: projectTypes.egg,
        assigned_to: 'egg-staff',
        is_deleted: false,
        agreement_links_migrated: true
      }],
      ['egg-unassigned', {
        project_type: projectTypes.egg,
        assigned_to: 'someone-else',
        is_deleted: false,
        agreement_links_migrated: true
      }],
      ['surrogacy-case', {
        project_type: projectTypes.surrogacy,
        assigned_to: 'someone-else',
        is_deleted: false,
        agreement_links_migrated: true
      }],
      ['surrogacy-egg-case', {
        project_type: projectTypes.surrogacyEgg,
        assigned_to: 'someone-else',
        is_deleted: false,
        agreement_links_migrated: true
      }],
      ['unmigrated-egg', {
        project_type: projectTypes.egg,
        assigned_to: 'egg-staff',
        is_deleted: false
      }],
      ['deleted-egg', {
        project_type: projectTypes.egg,
        assigned_to: 'egg-staff',
        is_deleted: true,
        agreement_links_migrated: true
      }]
    ];
    for (const [projectId, project] of projects) {
      await setDoc(doc(db, 'projects', projectId), project);
    }

    await setDoc(doc(db, 'project_agreements', 'egg-assigned'), {
      agreement_url: 'https://drive.google.com/egg-agreement'
    });
    await setDoc(doc(db, 'project_agreements', 'surrogacy-case'), {
      agreement_url: 'https://drive.google.com/surrogacy-agreement'
    });
  });
});

test('egg staff can query all migrated egg cases but not other types', async () => {
  const db = authenticatedDb('egg-staff');
  const eggQuery = query(
    collection(db, 'projects'),
    where('is_deleted', '==', false),
    where('agreement_links_migrated', '==', true),
    where('project_type', '==', projectTypes.egg)
  );
  const snapshot = await assertSucceeds(getDocs(eggQuery));
  assert.deepEqual(snapshot.docs.map((item) => item.id).sort(), ['egg-assigned', 'egg-unassigned']);
  await assertFails(getDoc(doc(db, 'projects', 'surrogacy-case')));
  await assertFails(getDoc(doc(db, 'projects', 'unmigrated-egg')));
  await assertFails(getDoc(doc(db, 'projects', 'deleted-egg')));
});

test('surrogacy staff can query both surrogacy types regardless of assignment', async () => {
  const db = authenticatedDb('sur-staff');
  const surrogacyQuery = query(
    collection(db, 'projects'),
    where('is_deleted', '==', false),
    where('agreement_links_migrated', '==', true),
    where('project_type', 'in', [projectTypes.surrogacy, projectTypes.surrogacyEgg])
  );
  const snapshot = await assertSucceeds(getDocs(surrogacyQuery));
  assert.deepEqual(snapshot.docs.map((item) => item.id).sort(), ['surrogacy-case', 'surrogacy-egg-case']);
});

test('staff can edit assigned cases only, while Staff_All retains active-project editing', async () => {
  const eggDb = authenticatedDb('egg-staff');
  await assertSucceeds(updateDoc(doc(eggDb, 'projects', 'egg-assigned'), { client_name: 'Updated' }));
  await assertFails(updateDoc(doc(eggDb, 'projects', 'egg-unassigned'), { client_name: 'Updated' }));

  const allDb = authenticatedDb('all-staff');
  await assertSucceeds(updateDoc(doc(allDb, 'projects', 'surrogacy-case'), { client_name: 'Updated' }));
});

test('agreement links require a separate user permission and matching project access', async () => {
  const deniedDb = authenticatedDb('egg-staff');
  await assertFails(getDoc(doc(deniedDb, 'project_agreements', 'egg-assigned')));
  await assertFails(getDoc(doc(deniedDb, 'project_agreements', 'surrogacy-case')));

  const allowedDb = authenticatedDb('egg-agreement-staff');
  await assertSucceeds(getDoc(doc(allowedDb, 'project_agreements', 'egg-assigned')));
  await assertFails(getDoc(doc(allowedDb, 'project_agreements', 'surrogacy-case')));
  await assertFails(updateDoc(doc(allowedDb, 'project_agreements', 'egg-assigned'), {
    agreement_url: 'https://drive.google.com/changed'
  }));
});

test('new staff cases must be migrated and cannot store an agreement URL on the project', async () => {
  const db = authenticatedDb('egg-staff');
  await assertSucceeds(setDoc(doc(db, 'projects', 'new-egg-case'), {
    project_type: projectTypes.egg,
    assigned_to: 'egg-staff',
    is_deleted: false,
    agreement_links_migrated: true
  }));
  await assertFails(setDoc(doc(db, 'projects', 'new-egg-with-link'), {
    project_type: projectTypes.egg,
    assigned_to: 'egg-staff',
    is_deleted: false,
    agreement_links_migrated: true,
    agreement_url: 'https://drive.google.com/unsafe-location'
  }));
});

test('admins can inspect unmigrated and recycled cases', async () => {
  const db = authenticatedDb('admin');
  await assertSucceeds(getDoc(doc(db, 'projects', 'unmigrated-egg')));
  await assertSucceeds(getDoc(doc(db, 'projects', 'deleted-egg')));
});
