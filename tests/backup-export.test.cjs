const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/    async function exportToJSON\(\) \{[\s\S]*?\n    \}\n\n    \/\/ --- PHONEBOOK/);
assert.ok(match, 'exportToJSON was not found');
const source = match[0].replace(/\n\n    \/\/ --- PHONEBOOK$/, '');

function createExport(failCollection) {
  const reads = [];
  const alerts = [];
  let download;
  const context = {
    requireAdminAccess: () => true,
    db: {
      collection(name) {
        reads.push(name);
        return {
          async get() {
            if (name === failCollection) throw new Error('read failed');
            return { forEach: callback => callback({ id: 'record-1', data: () => ({ value: name }) }) };
          }
        };
      }
    },
    document: {
      createElement() {
        const attrs = {};
        return {
          setAttribute(name, value) { attrs[name] = value; },
          click() { download = attrs; }
        };
      }
    },
    alert(message) { alerts.push(message); },
    console: { error() {} },
    Date,
    encodeURIComponent
  };
  vm.runInNewContext(source, context);
  return { run: () => context.exportToJSON(), reads, alerts, getDownload: () => download };
}

test('exports agreement records alongside other CRM data', async () => {
  const fixture = createExport();
  await fixture.run();
  assert.deepEqual(fixture.reads, [
    'projects', 'project_agreements', 'users', 'system_lists', 'phonebook', 'system_settings'
  ]);
  const download = fixture.getDownload();
  assert.ok(download);
  const payload = JSON.parse(decodeURIComponent(download.href.split(',')[1]));
  assert.deepEqual(payload.project_agreements, [{ id: 'record-1', value: 'project_agreements' }]);
  assert.deepEqual(fixture.alerts, []);
});

test('does not download an incomplete export when agreement retrieval fails', async () => {
  const fixture = createExport('project_agreements');
  await fixture.run();
  assert.equal(fixture.getDownload(), undefined);
  assert.equal(fixture.alerts.length, 1);
});
