import { OutputParser } from './dist/wrapper/parser.js';

const parser = new OutputParser({ prefix: '->relay:' });

// Test case 1: Simple multi-line with blank lines
const test1 = `->relay:Dashboard Line 1

Line 3
Line 4`;

console.log('Test 1: Message with blank line');
const result1 = parser.parse(test1 + '\n');
if (result1.commands.length > 0) {
  console.log('Body:', JSON.stringify(result1.commands[0].body));
  console.log('Lines:', result1.commands[0].body.split('\n').length);
} else {
  console.log('No command parsed');
}

// Test case 2: Without blank lines
const test2 = `->relay:Dashboard Line 1
Line 2
Line 3`;

console.log('\nTest 2: Message without blank lines');
parser.reset();
const result2 = parser.parse(test2 + '\n');
if (result2.commands.length > 0) {
  console.log('Body:', JSON.stringify(result2.commands[0].body));
  console.log('Lines:', result2.commands[0].body.split('\n').length);
} else {
  console.log('No command parsed');
}

// Test case 3: Multi-line with blank lines in middle
const test3 = `->relay:Dashboard TASK DETAILS: Something

More details here
Final line`;

console.log('\nTest 3: Real-world task message');
parser.reset();
const result3 = parser.parse(test3 + '\n');
if (result3.commands.length > 0) {
  console.log('Body:', JSON.stringify(result3.commands[0].body));
  console.log('Lines:', result3.commands[0].body.split('\n').length);
} else {
  console.log('No command parsed');
}
