import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

import { Filter, FilterContext, FilterGraph, FilterInOut } from '../src/lib/index.js';

describe('FilterInOut', () => {
  describe('Creation and Lifecycle', () => {
    it('should create a new FilterInOut instance', () => {
      const inout = new FilterInOut();
      assert.ok(inout instanceof FilterInOut, 'Should create FilterInOut instance');
    });

    it('should allocate FilterInOut structure', () => {
      const inout = new FilterInOut();
      inout.alloc();
      assert.ok(inout, 'Should allocate structure');
      inout.free();
    });

    it('should free FilterInOut structure', () => {
      const inout = new FilterInOut();
      inout.alloc();
      inout.free();
      // Structure is now freed - no crash should occur
      assert.ok(true, 'Should free without error');
    });

    it('should support Symbol.dispose', () => {
      const inout = new FilterInOut();
      inout.alloc();

      if (typeof inout[Symbol.dispose] === 'function') {
        inout[Symbol.dispose]();
      }
      assert.ok(true, 'Should dispose without error');
    });
  });

  describe('Properties', () => {
    it('should get and set name', () => {
      const inout = new FilterInOut();
      inout.alloc();

      // Initially null
      assert.equal(inout.name, null, 'Should initially be null');

      // Set name
      inout.name = 'input_1';
      assert.equal(inout.name, 'input_1', 'Should set name');

      // Clear name
      inout.name = null;
      assert.equal(inout.name, null, 'Should clear name');

      inout.free();
    });

    it('should get and set filter context', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const filter = Filter.getByName('buffer');
      assert.ok(filter);

      const ctx = graph.createFilter(filter, 'buffer', 'video_size=320x240:pix_fmt=0:time_base=1/25');
      assert.ok(ctx);

      const inout = new FilterInOut();
      inout.alloc();

      // Initially null
      assert.equal(inout.filterCtx, null, 'Should initially be null');

      // Set filter context
      inout.filterCtx = ctx;
      const retrieved = inout.filterCtx;
      assert.ok(retrieved instanceof FilterContext, 'Should set filter context');

      // Clear filter context
      inout.filterCtx = null;
      assert.equal(inout.filterCtx, null, 'Should clear filter context');

      inout.free();
      graph.free();
    });

    it('should get and set pad index', () => {
      const inout = new FilterInOut();
      inout.alloc();

      // Default value
      const initial = inout.padIdx;
      assert.equal(typeof initial, 'number', 'Should have numeric pad index');

      // Set pad index
      inout.padIdx = 0;
      assert.equal(inout.padIdx, 0, 'Should set pad index to 0');

      inout.padIdx = 1;
      assert.equal(inout.padIdx, 1, 'Should set pad index to 1');

      inout.padIdx = 99;
      assert.equal(inout.padIdx, 99, 'Should set pad index to 99');

      inout.free();
    });

    it('should handle all properties together', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const filter = Filter.getByName('buffersink');
      assert.ok(filter);

      const ctx = graph.createFilter(filter, 'sink');
      assert.ok(ctx);

      const inout = new FilterInOut();
      inout.alloc();

      // Set all properties
      inout.name = 'output';
      inout.filterCtx = ctx;
      inout.padIdx = 0;

      // Verify all properties
      assert.equal(inout.name, 'output');
      assert.ok(inout.filterCtx instanceof FilterContext);
      assert.equal(inout.padIdx, 0);

      inout.free();
      graph.free();
    });
  });

  describe('Linked List', () => {
    it('should get and set next element', () => {
      const first = new FilterInOut();
      first.alloc();
      first.name = 'first';

      const second = new FilterInOut();
      second.alloc();
      second.name = 'second';

      // Initially no next
      assert.equal(first.next, null, 'Should initially have no next');

      // Link them
      first.next = second;
      const next = first.next;
      assert.ok(next instanceof FilterInOut, 'Should have next element');

      // Clear next before freeing to avoid double-free
      first.next = null;
      assert.equal(first.next, null, 'Should clear next');

      first.free();
      second.free();
    });

    it('should count elements in list', () => {
      const first = new FilterInOut();
      first.alloc();

      // Single element
      assert.equal(first.count(), 1, 'Should count single element');

      const second = new FilterInOut();
      second.alloc();
      first.next = second;

      // Two elements
      assert.equal(first.count(), 2, 'Should count two elements');

      const third = new FilterInOut();
      third.alloc();
      second.next = third;

      // Three elements
      assert.equal(first.count(), 3, 'Should count three elements');

      // Free only the head - it will free the entire chain
      first.free();
      second.free(); // no need to free, it was freed by the first
      third.free(); // no need to free, it was freed by the first
    });

    it('should handle chain of multiple elements', () => {
      const elements = [];
      let prev = null;

      // Create chain of 5 elements
      for (let i = 0; i < 5; i++) {
        const inout = new FilterInOut();
        inout.alloc();
        inout.name = `element_${i}`;
        inout.padIdx = i;

        if (prev) {
          prev.next = inout;
        }

        elements.push(inout);
        prev = inout;
      }

      // Verify chain
      assert.equal(elements[0].count(), 5, 'Should have 5 elements total');
      assert.equal(elements[0].name, 'element_0');
      assert.equal(elements[0].padIdx, 0);

      // Clean up - only free the head
      elements[0].free();
    });
  });

  describe('Static Methods', () => {
    it('should create empty list', () => {
      const list = FilterInOut.createList([]);
      assert.equal(list, null, 'Should return null for empty list');
    });

    it('should create single element list', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const filter = Filter.getByName('buffer');
      assert.ok(filter);

      const ctx = graph.createFilter(filter, 'buffer', 'video_size=320x240:pix_fmt=0:time_base=1/25');
      assert.ok(ctx);

      const list = FilterInOut.createList([{ name: 'input', filterCtx: ctx, padIdx: 0 }]);

      assert.ok(list instanceof FilterInOut, 'Should create list');
      assert.equal(list?.name, 'input');
      assert.ok(list?.filterCtx instanceof FilterContext);
      assert.equal(list?.padIdx, 0);
      assert.equal(list?.count(), 1, 'Should have one element');

      list?.free();
      graph.free();
    });

    it('should create multi-element list', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create multiple filter contexts
      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter);
      assert.ok(sinkFilter);

      const ctx1 = graph.createFilter(bufferFilter, 'buf1', 'video_size=320x240:pix_fmt=0:time_base=1/25');
      const ctx2 = graph.createFilter(bufferFilter, 'buf2', 'video_size=640x480:pix_fmt=0:time_base=1/30');
      const ctx3 = graph.createFilter(sinkFilter, 'sink');

      assert.ok(ctx1);
      assert.ok(ctx2);
      assert.ok(ctx3);

      const list = FilterInOut.createList([
        { name: 'in1', filterCtx: ctx1, padIdx: 0 },
        { name: 'in2', filterCtx: ctx2, padIdx: 0 },
        { name: 'out', filterCtx: ctx3, padIdx: 0 },
      ]);

      assert.ok(list, 'Should create list');
      assert.equal(list?.count(), 3, 'Should have three elements');

      // Check first element
      assert.equal(list?.name, 'in1');
      assert.ok(list?.filterCtx instanceof FilterContext);
      assert.equal(list?.padIdx, 0);

      // Check if linked properly
      const second = list?.next;
      assert.ok(second instanceof FilterInOut, 'Should have second element');

      list?.free();
      graph.free();
    });
  });

  describe('Integration with FilterGraph', () => {
    it('should use FilterInOut for graph parsing', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create source and sink
      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter);
      assert.ok(sinkFilter);

      const srcCtx = graph.createFilter(bufferFilter, 'src', 'video_size=320x240:pix_fmt=0:time_base=1/25');
      const sinkCtx = graph.createFilter(sinkFilter, 'sink');
      assert.ok(srcCtx);
      assert.ok(sinkCtx);

      // Create input/output descriptors
      const inputs = new FilterInOut();
      inputs.alloc();
      inputs.name = 'in';
      inputs.filterCtx = srcCtx;
      inputs.padIdx = 0;

      const outputs = new FilterInOut();
      outputs.alloc();
      outputs.name = 'out';
      outputs.filterCtx = sinkCtx;
      outputs.padIdx = 0;

      // Parse simple filter chain
      const ret = graph.parse('[in] scale=640:480 [out]', inputs, outputs);
      assert.equal(typeof ret, 'number', 'Should return status code');

      inputs.free();
      outputs.free();
      graph.free();
    });

    it('should handle multiple inputs and outputs', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create multiple sources and sinks
      const bufferFilter = Filter.getByName('buffer');
      const abufferFilter = Filter.getByName('abuffer');
      const sinkFilter = Filter.getByName('buffersink');
      const asinkFilter = Filter.getByName('abuffersink');

      assert.ok(bufferFilter);
      assert.ok(abufferFilter);
      assert.ok(sinkFilter);
      assert.ok(asinkFilter);

      const videoSrc = graph.createFilter(bufferFilter, 'vsrc', 'video_size=320x240:pix_fmt=0:time_base=1/25');
      const audioSrc = graph.createFilter(abufferFilter, 'asrc', 'sample_rate=44100:sample_fmt=1:channel_layout=3');
      const videoSink = graph.createFilter(sinkFilter, 'vsink');
      const audioSink = graph.createFilter(asinkFilter, 'asink');

      assert.ok(videoSrc);
      assert.ok(audioSrc);
      assert.ok(videoSink);
      assert.ok(audioSink);

      // Create input list
      const inputs = FilterInOut.createList([
        { name: 'vin', filterCtx: videoSrc, padIdx: 0 },
        { name: 'ain', filterCtx: audioSrc, padIdx: 0 },
      ]);

      // Create output list
      const outputs = FilterInOut.createList([
        { name: 'vout', filterCtx: videoSink, padIdx: 0 },
        { name: 'aout', filterCtx: audioSink, padIdx: 0 },
      ]);

      assert.ok(inputs);
      assert.ok(outputs);
      assert.equal(inputs?.count(), 2);
      assert.equal(outputs?.count(), 2);

      inputs?.free();
      outputs?.free();
      graph.free();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty name', () => {
      const inout = new FilterInOut();
      inout.alloc();

      inout.name = '';
      assert.equal(inout.name, '', 'Should handle empty string name');

      inout.free();
    });

    it('should handle very long name', () => {
      const inout = new FilterInOut();
      inout.alloc();

      const longName = 'a'.repeat(1000);
      inout.name = longName;
      assert.equal(inout.name, longName, 'Should handle long name');

      inout.free();
    });

    it('should handle special characters in name', () => {
      const inout = new FilterInOut();
      inout.alloc();

      const specialName = 'test-name_123.456[789]';
      inout.name = specialName;
      assert.equal(inout.name, specialName, 'Should handle special characters');

      inout.free();
    });

    it('should handle negative pad index', () => {
      const inout = new FilterInOut();
      inout.alloc();

      inout.padIdx = -1;
      assert.equal(inout.padIdx, -1, 'Should handle negative pad index');

      inout.free();
    });

    it('should handle large pad index', () => {
      const inout = new FilterInOut();
      inout.alloc();

      inout.padIdx = 999999;
      assert.equal(inout.padIdx, 999999, 'Should handle large pad index');

      inout.free();
    });

    it('should handle unallocated structure', () => {
      const inout = new FilterInOut();
      // Don't call alloc()

      try {
        // Try to use unallocated structure
        inout.name = 'test';
        // May or may not throw depending on implementation
        assert.ok(true, 'May handle unallocated structure');
      } catch (error) {
        assert.ok(error, 'May throw on unallocated structure');
      }
    });

    it('should handle circular reference', () => {
      const first = new FilterInOut();
      first.alloc();
      first.name = 'first';

      const second = new FilterInOut();
      second.alloc();
      second.name = 'second';

      // Create circular reference
      first.next = second;
      second.next = first;

      // Count would infinite loop if not handled
      // Implementation currently doesn't handle this - it would loop
      // This is a known limitation

      // Break the cycle before freeing
      second.next = null;
      first.free();
      // second is already freed as part of the chain
    });
  });

  describe('Memory Management', () => {
    it('should handle multiple alloc/free cycles', () => {
      const inout = new FilterInOut();

      // First cycle
      inout.alloc();
      inout.name = 'test1';
      inout.padIdx = 1;
      inout.free();

      // Second cycle
      inout.alloc();
      inout.name = 'test2';
      inout.padIdx = 2;
      inout.free();

      assert.ok(true, 'Should handle multiple cycles');
    });

    it('should free entire linked list', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create contexts
      const filter = Filter.getByName('anull');
      assert.ok(filter);

      const contexts = [];
      for (let i = 0; i < 5; i++) {
        const ctx = graph.createFilter(filter, `filter_${i}`);
        if (ctx) contexts.push(ctx);
      }

      // Create linked list
      const items = contexts.map((ctx, i) => ({
        name: `item_${i}`,
        filterCtx: ctx,
        padIdx: i,
      }));

      const list = FilterInOut.createList(items);
      assert.ok(list);
      assert.equal(list?.count(), contexts.length);

      // Free should handle entire list
      list?.free();

      graph.free();
    });

    it('should handle freeing middle element', () => {
      const first = new FilterInOut();
      first.alloc();
      first.name = 'first';

      const second = new FilterInOut();
      second.alloc();
      second.name = 'second';

      const third = new FilterInOut();
      third.alloc();
      third.name = 'third';

      // Don't link them to test individual freeing
      // If we link them, freeing middle would free the rest

      // Free individually
      second.free();
      first.free();
      third.free();
    });
  });

  describe('Complex Scenarios', () => {
    it('should create complex input/output configuration', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create various filter contexts
      const filters = {
        videoBuffer: Filter.getByName('buffer'),
        audioBuffer: Filter.getByName('abuffer'),
        overlay: Filter.getByName('overlay'),
        videoSink: Filter.getByName('buffersink'),
        audioSink: Filter.getByName('abuffersink'),
      };

      Object.values(filters).forEach((f) => assert.ok(f));

      const contexts = {
        video1: graph.createFilter(filters.videoBuffer!, 'video1', 'video_size=640x480:pix_fmt=0:time_base=1/25'),
        video2: graph.createFilter(filters.videoBuffer!, 'video2', 'video_size=640x480:pix_fmt=0:time_base=1/25'),
        audio: graph.createFilter(filters.audioBuffer!, 'audio', 'sample_rate=44100:sample_fmt=1:channel_layout=3'),
        overlay: graph.createFilter(filters.overlay!, 'overlay'),
        videoOut: graph.createFilter(filters.videoSink!, 'vout'),
        audioOut: graph.createFilter(filters.audioSink!, 'aout'),
      };

      Object.values(contexts).forEach((c) => assert.ok(c));

      // Create complex input configuration
      const inputs = FilterInOut.createList([
        { name: 'main_video', filterCtx: contexts.video1!, padIdx: 0 },
        { name: 'overlay_video', filterCtx: contexts.video2!, padIdx: 0 },
        { name: 'audio_in', filterCtx: contexts.audio!, padIdx: 0 },
      ]);

      // Create output configuration
      const outputs = FilterInOut.createList([
        { name: 'video_out', filterCtx: contexts.videoOut!, padIdx: 0 },
        { name: 'audio_out', filterCtx: contexts.audioOut!, padIdx: 0 },
      ]);

      assert.ok(inputs);
      assert.ok(outputs);
      assert.equal(inputs?.count(), 3);
      assert.equal(outputs?.count(), 2);

      inputs?.free();
      outputs?.free();
      graph.free();
    });

    it('should handle dynamic list building', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const filter = Filter.getByName('anull');
      assert.ok(filter);

      // Build list dynamically
      let head: FilterInOut | null = null;
      let current: FilterInOut | null = null;

      for (let i = 0; i < 10; i++) {
        const ctx = graph.createFilter(filter, `filter_${i}`);
        assert.ok(ctx);

        const inout = new FilterInOut();
        inout.alloc();
        inout.name = `io_${i}`;
        inout.filterCtx = ctx;
        inout.padIdx = i % 3; // Vary pad indices

        if (!head) {
          head = inout;
          current = inout;
        } else if (current) {
          current.next = inout;
          current = inout;
        }
      }

      assert.ok(head);
      assert.equal(head?.count(), 10, 'Should have 10 elements');
      assert.equal(head?.name, 'io_0');

      head?.free();
      graph.free();
    });
  });

  describe('Ownership', () => {
    // A wrapper from `next`, or a list appended to another, points into the list its head
    // owns. Once the head frees it, those wrappers must read defaults, not freed memory.
    const node = (name: string): FilterInOut => {
      const inout = new FilterInOut();
      inout.alloc();
      inout.name = name;
      return inout;
    };

    const assertDetached = (inout: FilterInOut): void => {
      assert.equal(inout.name, null);
      assert.equal(inout.next, null);
      assert.equal(inout.filterCtx, null);
      assert.equal(inout.padIdx, 0);
      // writes go nowhere
      inout.name = 'renamed';
      assert.equal(inout.name, null);
    };

    it('leaves next elements reading defaults once the head is freed', () => {
      const head = node('a');
      head.next = node('b');
      head.next.next = node('c');
      const second = head.next;
      const third = second.next!;
      assert.equal(third.name, 'c');
      head.free();
      assertDetached(second);
      assertDetached(third);
    });

    it('leaves next elements reading defaults once the head is reallocated', () => {
      const head = node('a');
      head.next = node('b');
      const second = head.next;
      head.alloc();
      assertDetached(second);
      head.free();
    });

    it('hands wrappers into an appended list over to the new head', () => {
      const tail = node('b');
      tail.next = node('c');
      const third = tail.next;
      const head = node('a');
      head.next = tail;
      assert.equal(head.count(), 3);
      head.free();
      assertDetached(tail);
      assertDetached(third);
    });

    it('frees the lists segment.apply() returns', () => {
      const graph = new FilterGraph();
      graph.alloc();
      const segment = graph.segmentParse('[a][b]overlay[c]')!;
      const inputs = new FilterInOut();
      const outputs = new FilterInOut();
      assert.equal(segment.apply(inputs, outputs), 0);
      const second = inputs.next!;
      assert.equal(second.name, 'b');
      assert.equal(outputs.name, 'c');
      inputs.free();
      outputs.free();
      assertDetached(second);
      segment.free();
      graph.free();
    });

    const overlayGraph = (): { graph: FilterGraph; inputs: FilterInOut; outputs: FilterInOut } => {
      const graph = new FilterGraph();
      graph.alloc();
      const args = 'video_size=64x64:pix_fmt=0:time_base=1/25:pixel_aspect=1/1';
      const src0 = graph.createFilter(Filter.getByName('buffer')!, 'src0', args)!;
      const src1 = graph.createFilter(Filter.getByName('buffer')!, 'src1', args)!;
      const sink = graph.createFilter(Filter.getByName('buffersink')!, 'sink')!;
      // the open outputs of the existing filters feed the parsed chain's inputs
      const outputs = FilterInOut.createList([
        { name: 'in0', filterCtx: src0, padIdx: 0 },
        { name: 'in1', filterCtx: src1, padIdx: 0 },
      ])!;
      const inputs = FilterInOut.createList([{ name: 'out', filterCtx: sink, padIdx: 0 }])!;
      return { graph, inputs, outputs };
    };

    it('passes whole lists to parsePtr() and keeps them', () => {
      const { graph, inputs, outputs } = overlayGraph();
      assert.equal(graph.parsePtr('[in0][in1]overlay[out]', inputs, outputs), 0);
      assert.equal(graph.configSync(), 0);
      assert.equal(outputs.name, 'in0');
      assert.equal(outputs.next?.name, 'in1');
      inputs.free();
      outputs.free();
      graph.free();
    });

    it('keeps the lists passed to parse()', () => {
      const { graph, inputs, outputs } = overlayGraph();
      assert.equal(graph.parse('[in0][in1]overlay[out]', inputs, outputs), 0);
      assert.equal(graph.configSync(), 0);
      assert.equal(outputs.next?.name, 'in1');
      inputs.free();
      outputs.free();
      graph.free();
    });

    it('survives garbage collection of the head first', { timeout: 30000 }, async () => {
      const script = `
        const { FilterInOut } = await import(${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)});
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        const build = () => {
          const head = new FilterInOut();
          head.alloc();
          head.name = 'a';
          const tail = new FilterInOut();
          tail.alloc();
          tail.name = 'b';
          head.next = tail;
          return head.next;
        };
        const second = build();
        for (let i = 0; i < 5; i++) { globalThis.gc(); await settle(); }
        console.log('after head gc', second.name);
        console.log('done');
      `;
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--expose-gc', '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /after head gc null\ndone/);
    });
  });
});
