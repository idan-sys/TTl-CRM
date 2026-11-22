const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/    async function updateClientDetails\(\) \{[\s\S]*?\n    \}\n\n    async function moveToRecycleBin/);
assert.ok(match, 'client save function was not found');
const source = match[0].replace(/\n\n    async function moveToRecycleBin$/, '');
const createMatch = html.match(/    function selectProject\(type\) \{[\s\S]*?\n    \}\n\n    function loadProjects/);
assert.ok(createMatch, 'client creation functions were not found');
const createSource = createMatch[0].replace(/\n\n    function loadProjects$/, '');

test('a surrogacy project can optionally include egg donation without creating a separate project', async () => {
  const elements = {};
  for (const id of ['cardChoiceEgg', 'cardChoiceSur', 'newSurEggWrap', 'newSurEgg', 'selectedNewClientProject', 'newClientName']) {
    elements[id] = {
      style: {}, value: '', checked: false,
      classList: { toggle() {} }, setAttribute() {}
    };
  }
  elements.newClientName.value = 'Client';
  const created = [];
  const context = {
    document: { getElementById: id => elements[id] },
    currentUser: { uid: 'user' }, currentUserRole: 'Staff_Sur',
    db: { collection: () => ({ add: async project => created.push(project) }) },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'timestamp' } } },
    closeModal() {}, alert: message => { throw new Error(message); }, console
  };
  vm.runInNewContext(createSource, context);
  context.selectProject('sur');
  assert.equal(elements.newSurEggWrap.style.display, 'block');
  assert.equal(elements.newSurEgg.checked, false);
  await context.saveNewClient();
  elements.newClientName.value = 'Second client';
  context.selectProject('surEgg');
  assert.equal(elements.newSurEgg.checked, true);
  await context.saveNewClient();
  assert.equal(created.length, 2);
  assert.equal(created[0].project_type, 'פונדקאות - גאורגיה');
  assert.equal(created[1].project_type, 'פונדקאות + תרומת ביצית - גאורגיה');
  assert.equal(elements.newSurEgg.checked, false);
  assert.equal(elements.selectedNewClientProject.value, 'sur');
  context.selectProject('egg');
  assert.equal(elements.newSurEggWrap.style.display, 'none');
  assert.equal(elements.newSurEgg.checked, false);
});

async function saveProject({ role = 'Admin', projectType, selectedType }) {
  const project = {
    id: 'project', project_type: projectType,
    agreement_links_migrated: true, track_sur: 'מסלול VIP'
  };
  const fields = {
    detProjectId: { value: project.id },
    detSurProjectType: { value: selectedType },
    detFullName: { value: 'Client' },
    btnUpdateClient: { innerText: '' }
  };
  const alerts = [];
  let update;
  const context = {
    currentUserRole: role, currentUser: { uid: 'user' }, allProjects: [project],
    canEditProject: () => true,
    isSurrogacyProject: type => type.includes('פונדקאות'),
    safeHttpsUrl: () => '',
    alert: message => alerts.push(message),
    setTimeout: () => {},
    console,
    document: {
      getElementById(id) { return fields[id] || (fields[id] = { value: '' }); },
      querySelectorAll() { return []; }
    },
    db: {
      collection: name => ({ doc: id => ({ name, id }) }),
      batch: () => ({
        update: (ref, data) => { update = data; },
        delete: () => {},
        commit: async () => {}
      })
    }
  };
  vm.runInNewContext(source, context);
  await context.updateClientDetails();
  return { update, alerts };
}

test('administrator can change the project classification without overwriting the old track', async () => {
  const result = await saveProject({
    projectType: 'פונדקאות - גאורגיה',
    selectedType: 'פונדקאות + תרומת ביצית - גאורגיה'
  });
  assert.equal(result.update.project_type, 'פונדקאות + תרומת ביצית - גאורגיה');
  assert.equal(Object.hasOwn(result.update, 'track_sur'), false);
  assert.equal(result.alerts.length, 0);
});

test('saving unchanged legacy classification or staff edits does not rewrite either track field', async () => {
  for (const role of ['Admin', 'Staff_All']) {
    const result = await saveProject({ role, projectType: 'פונדקאות ישן', selectedType: 'פונדקאות ישן' });
    assert.ok(result.update);
    assert.equal(Object.hasOwn(result.update, 'project_type'), false);
    assert.equal(Object.hasOwn(result.update, 'track_sur'), false);
  }
});

test('administrator cannot change the classification to an invalid value', async () => {
  const result = await saveProject({ projectType: 'פונדקאות - גאורגיה', selectedType: 'invalid' });
  assert.equal(result.update, undefined);
  assert.equal(result.alerts.length, 1);
});
