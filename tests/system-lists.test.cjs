const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/    function updateDropdowns\(\) \{[\s\S]*?\n    function renderControlPanel\(\)/);
assert.ok(match, 'system list functions were not found');
const source = match[0].replace(/\n    function renderControlPanel\(\)$/, '');

function makeSelect() {
  const select = {
    options: [],
    selected: '',
    replaceChildren(option) {
      this.options = [option];
      option.parent = this;
      this.selected = option.value;
    },
    appendChild(option) {
      option.parent = this;
      this.options.push(option);
    },
    get firstElementChild() { return this.options[0]; },
    get value() { return this.selected; },
    set value(value) {
      this.selected = this.options.some(option => option.value === value) ? value : '';
    }
  };
  return select;
}

function makeOption(text) {
  return {
    textContent: text,
    value: text,
    dataset: {},
    remove() {
      this.parent.options = this.parent.options.filter(option => option !== this);
    }
  };
}

test('preserves saved and unsaved selections when a list entry is changed or removed', () => {
  const selects = Object.fromEntries(
    ['detDoctor', 'detTrack', 'detStatusEgg', 'detStageSur'].map(id => [id, makeSelect()])
  );
  const context = {
    document: { getElementById: id => selects[id] },
    createTextElement: (_tag, text) => makeOption(text),
    sysLists: [{ list_type: 'Cyprus_Status', item_name: 'ישן', is_active: true }]
  };
  vm.runInNewContext(source, context);
  context.updateDropdowns();
  selects.detStatusEgg.value = 'ישן';
  context.sysLists = [{ list_type: 'Cyprus_Status', item_name: 'חדש', is_active: true }];
  context.updateDropdowns();

  assert.equal(selects.detStatusEgg.value, 'ישן');
  assert.equal(selects.detStatusEgg.options.find(option => option.value === 'ישן').textContent, 'ישן (לא ברשימה)');
  assert.ok(selects.detStatusEgg.options.some(option => option.value === 'חדש'));

  context.setListSelectValue(selects.detStatusEgg, 'חדש');
  assert.equal(selects.detStatusEgg.value, 'חדש');
  assert.equal(selects.detStatusEgg.options.some(option => option.value === 'ישן'), false);
});

test('shows a saved value absent from the current list when opening a record', () => {
  const select = makeSelect();
  select.replaceChildren(makeOption(''));
  const context = { createTextElement: (_tag, text) => makeOption(text) };
  vm.runInNewContext(source, context);
  context.setListSelectValue(select, 'סטטוס קודם');
  assert.equal(select.value, 'סטטוס קודם');
  assert.equal(select.options[1].textContent, 'סטטוס קודם (לא ברשימה)');
});
