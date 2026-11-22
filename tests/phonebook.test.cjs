const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const emailMatch = html.match(/    function safeEmailAddress\(value\) \{[\s\S]*?\n    \}/);
const renderMatch = html.match(/    function renderPhonebook\(\) \{[\s\S]*?\n    \}\n    async function addContact/);
assert.ok(emailMatch && renderMatch, 'phonebook functions were not found');

function node(tag, text = '') {
  return {
    tag, textContent: text, children: [], attributes: {},
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

test('phonebook links both addresses safely and preserves invalid addresses as text', () => {
  const body = node('tbody');
  const context = {
    currentPbTab: 'staff',
    currentUserRole: 'Staff_All',
    contacts: [
      { contact_type: 'staff', contact_name: 'Test', email_1: 'person+tag@example.com', email_2: 'other?subject=x@example.com' },
      { contact_type: 'staff', contact_name: 'Other', email_1: 'bad email' }
    ],
    document: {
      getElementById: id => id === 'pbSearch' ? { value: '' } : body,
      createElement: tag => node(tag),
      createTextNode: text => node('#text', text)
    },
    createTextElement: (tag, text, className) => Object.assign(node(tag, text), { className }),
    appendTextCell(row, text, className) {
      const cell = Object.assign(node('td', text), { className });
      row.appendChild(cell);
      return cell;
    },
    encodeURIComponent
  };
  vm.runInNewContext(`${emailMatch[0]}\n${renderMatch[0].replace(/\n    async function addContact$/, '')}`, context);
  context.renderPhonebook();
  const emailCell = body.children.find(row => row.children[0].textContent === 'Test').children[2];
  assert.equal(emailCell.children[0].href, 'mailto:person%2Btag@example.com');
  assert.equal(emailCell.children[0].textContent, 'person+tag@example.com');
  assert.equal(emailCell.children[2].href, 'mailto:other%3Fsubject%3Dx@example.com');
  const invalidCell = body.children.find(row => row.children[0].textContent === 'Other').children[2];
  assert.equal(invalidCell.children[0].tag, '#text');
  assert.equal(invalidCell.children[0].textContent, 'bad email');
});
