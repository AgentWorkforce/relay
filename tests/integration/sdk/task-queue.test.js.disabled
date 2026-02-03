/**
 * Task Queue System Tests
 * Agent3 - Tests for queue.js, priority.js, and worker.js integration
 */

import { TaskQueue } from '../task-queue/queue.js';
import { createWorker } from '../task-queue/worker.js';

// Import priority using dynamic import for CommonJS compatibility
const priority = await import('../task-queue/priority.js');
const { Priority, sortByPriority, getHighestPriority, createPrioritizedTask } = priority;

console.log('=== Task Queue System Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ============================================
// TaskQueue Tests
// ============================================
console.log('TaskQueue Tests:');

test('should create empty queue', () => {
  const queue = new TaskQueue();
  const stats = queue.getStats();
  assert(stats.pending === 0, 'Expected 0 pending');
  assert(stats.total === 0, 'Expected 0 total');
});

test('should add tasks with auto-incrementing IDs', () => {
  const queue = new TaskQueue();
  const task1 = queue.add({ name: 'Task 1' });
  const task2 = queue.add({ name: 'Task 2' });
  assert(task1.id === 1, 'First task should have ID 1');
  assert(task2.id === 2, 'Second task should have ID 2');
  assert(task1.status === 'pending', 'New task should be pending');
});

test('should process tasks in FIFO order', () => {
  const queue = new TaskQueue();
  queue.add({ name: 'First' });
  queue.add({ name: 'Second' });

  const processed = queue.process();
  assert(processed.name === 'First', 'Should process first task');
  assert(processed.status === 'processing', 'Status should be processing');
});

test('should complete tasks and move to completed list', () => {
  const queue = new TaskQueue();
  const task = queue.add({ name: 'Test' });
  queue.process();
  const completed = queue.complete(task.id);

  assert(completed.status === 'completed', 'Status should be completed');
  assert(completed.completedAt, 'Should have completedAt timestamp');

  const stats = queue.getStats();
  assert(stats.completed === 1, 'Should have 1 completed');
  assert(stats.pending === 0, 'Should have 0 pending');
});

test('should return null when processing empty queue', () => {
  const queue = new TaskQueue();
  const result = queue.process();
  assert(result === null, 'Should return null for empty queue');
});

test('should track processing tasks', () => {
  const queue = new TaskQueue();
  queue.add({ name: 'Task 1' });
  queue.add({ name: 'Task 2' });

  queue.process();

  assert(queue.getPending().length === 1, 'Should have 1 pending');
  assert(queue.getProcessing().length === 1, 'Should have 1 processing');
});

// ============================================
// Priority Tests
// ============================================
console.log('\nPriority Tests:');

test('should have correct priority levels', () => {
  assert(Priority.CRITICAL === 0, 'CRITICAL should be 0');
  assert(Priority.HIGH === 1, 'HIGH should be 1');
  assert(Priority.NORMAL === 2, 'NORMAL should be 2');
  assert(Priority.LOW === 3, 'LOW should be 3');
  assert(Priority.IDLE === 4, 'IDLE should be 4');
});

test('should sort tasks by priority', () => {
  const tasks = [
    { name: 'Low', priority: Priority.LOW },
    { name: 'Critical', priority: Priority.CRITICAL },
    { name: 'Normal', priority: Priority.NORMAL },
  ];

  const sorted = sortByPriority(tasks);
  assert(sorted[0].name === 'Critical', 'Critical should be first');
  assert(sorted[1].name === 'Normal', 'Normal should be second');
  assert(sorted[2].name === 'Low', 'Low should be last');
});

test('should get highest priority task', () => {
  const tasks = [
    { name: 'Low', priority: Priority.LOW },
    { name: 'High', priority: Priority.HIGH },
    { name: 'Normal', priority: Priority.NORMAL },
  ];

  const highest = getHighestPriority(tasks);
  assert(highest.name === 'High', 'Should return High priority task');
});

test('should return null for empty array', () => {
  const result = getHighestPriority([]);
  assert(result === null, 'Should return null for empty array');
});

test('should create prioritized task with metadata', () => {
  const task = createPrioritizedTask('Test Task', Priority.HIGH, { data: 'test' });
  assert(task.name === 'Test Task', 'Should have correct name');
  assert(task.priority === Priority.HIGH, 'Should have correct priority');
  assert(task.priorityLabel === 'HIGH', 'Should have priority label');
  assert(task.data === 'test', 'Should include extra data');
  assert(task.id, 'Should have an ID');
  assert(task.createdAt, 'Should have createdAt timestamp');
});

// ============================================
// Worker Tests
// ============================================
console.log('\nWorker Tests:');

// Create a queue adapter that maps process() to getNext()
function createQueueAdapter(queue) {
  return {
    getNext: () => queue.process(),
    complete: (id) => queue.complete(id),
    fail: (id, error) => {
      // Handle failed tasks (optional in base queue)
      const task = queue.tasks.find(t => t.id === id);
      if (task) {
        task.status = 'failed';
        task.error = error.message;
      }
    }
  };
}

test('should create worker with default options', () => {
  const queue = new TaskQueue();
  const adapter = createQueueAdapter(queue);
  const worker = createWorker(adapter, async () => {});

  assert(typeof worker.start === 'function', 'Should have start method');
  assert(typeof worker.stop === 'function', 'Should have stop method');
  assert(typeof worker.status === 'function', 'Should have status method');
  assert(typeof worker.isRunning === 'function', 'Should have isRunning method');
});

test('should report not running initially', () => {
  const queue = new TaskQueue();
  const adapter = createQueueAdapter(queue);
  const worker = createWorker(adapter, async () => {});

  assert(!worker.isRunning(), 'Should not be running initially');
  const status = worker.status();
  assert(status.running === false, 'Status should show not running');
  assert(status.processedCount === 0, 'Should have 0 processed');
});

test('should process tasks when started', async () => {
  const queue = new TaskQueue();
  const adapter = createQueueAdapter(queue);
  const processed = [];

  queue.add({ name: 'Task 1' });
  queue.add({ name: 'Task 2' });

  const worker = createWorker(adapter, async (task) => {
    processed.push(task.name);
    await new Promise(r => setTimeout(r, 10));
  }, { pollInterval: 10 });

  worker.start();
  assert(worker.isRunning(), 'Should be running after start');

  // Wait for processing
  await new Promise(r => setTimeout(r, 100));
  await worker.stop();

  assert(processed.length === 2, 'Should have processed 2 tasks');
  assert(processed.includes('Task 1'), 'Should have processed Task 1');
  assert(processed.includes('Task 2'), 'Should have processed Task 2');
});

test('should call lifecycle callbacks', async () => {
  const queue = new TaskQueue();
  const adapter = createQueueAdapter(queue);
  const events = [];

  queue.add({ name: 'Callback Test' });

  const worker = createWorker(adapter, async (task) => {
    await new Promise(r => setTimeout(r, 5));
  }, {
    pollInterval: 10,
    onTaskStart: (task) => events.push(`start:${task.name}`),
    onTaskComplete: (task) => events.push(`complete:${task.name}`),
  });

  worker.start();
  await new Promise(r => setTimeout(r, 100));
  await worker.stop();

  assert(events.includes('start:Callback Test'), 'Should call onTaskStart');
  assert(events.includes('complete:Callback Test'), 'Should call onTaskComplete');
});

test('should handle task errors gracefully', async () => {
  const queue = new TaskQueue();
  const adapter = createQueueAdapter(queue);
  const errors = [];

  queue.add({ name: 'Error Task' });
  queue.add({ name: 'Good Task' });

  const worker = createWorker(adapter, async (task) => {
    if (task.name === 'Error Task') {
      throw new Error('Task failed');
    }
  }, {
    pollInterval: 10,
    onTaskError: (task, error) => errors.push({ task: task.name, error: error.message }),
  });

  worker.start();
  await new Promise(r => setTimeout(r, 100));
  await worker.stop();

  const status = worker.status();
  assert(status.errorCount === 1, 'Should have 1 error');
  assert(status.processedCount === 1, 'Should have 1 successful');
  assert(errors[0].task === 'Error Task', 'Should report error for correct task');
});

test('should respect concurrency limit', async () => {
  const queue = new TaskQueue();
  const adapter = createQueueAdapter(queue);
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  for (let i = 0; i < 5; i++) {
    queue.add({ name: `Task ${i}` });
  }

  const worker = createWorker(adapter, async (task) => {
    currentConcurrent++;
    maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
    await new Promise(r => setTimeout(r, 20));
    currentConcurrent--;
  }, { concurrency: 2, pollInterval: 5 });

  worker.start();
  await new Promise(r => setTimeout(r, 200));
  await worker.stop();

  assert(maxConcurrent <= 2, `Max concurrent should be <= 2, got ${maxConcurrent}`);
});

// ============================================
// Integration Tests
// ============================================
console.log('\nIntegration Tests:');

test('should integrate queue with priority sorting', () => {
  const queue = new TaskQueue();

  // Add tasks with different priorities
  queue.add({ name: 'Low Priority', priority: Priority.LOW });
  queue.add({ name: 'Critical', priority: Priority.CRITICAL });
  queue.add({ name: 'Normal', priority: Priority.NORMAL });

  // Get pending and sort by priority
  const pending = queue.getPending();
  const sorted = sortByPriority(pending);

  assert(sorted[0].name === 'Critical', 'Critical should be first after sort');
  assert(sorted[2].name === 'Low Priority', 'Low should be last after sort');
});

// ============================================
// Summary
// ============================================
console.log('\n=== Test Summary ===');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
}
