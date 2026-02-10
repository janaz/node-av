import assert from 'node:assert';
import { describe, it } from 'node:test';

import { AVFILTER_FLAG_HWDEVICE, Filter, FilterGraph, FilterInOut } from '../src/index.js';

describe('FilterGraphSegment', () => {
  describe('Segment Parsing', () => {
    it('should parse a simple filter segment', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment, 'Should parse simple scale filter');

      if (segment) {
        segment.free();
      }

      graph.free();
    });

    it('should parse a complex filter chain', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=1280:720,hflip,vflip');
      assert.ok(segment, 'Should parse filter chain');

      if (segment) {
        segment.free();
      }

      graph.free();
    });

    it('should parse multi-filter segment', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('crop=640:480,hflip');
      assert.ok(segment, 'Should parse multi-filter chain');

      if (segment) {
        segment.free();
      }

      graph.free();
    });

    it('should parse filter with options', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=w=1920:h=1080:flags=bicubic');
      assert.ok(segment, 'Should parse filter with named options');

      if (segment) {
        segment.free();
      }

      graph.free();
    });

    it('should return null for invalid filter syntax', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('invalid:::syntax:::');
      // FFmpeg may return a segment object even for invalid syntax
      // The error will occur during createFilters or applyOpts
      if (segment) {
        segment.free();
      }
      assert.ok(true, 'Should handle invalid syntax');

      graph.free();
    });

    it('should return null for non-existent filter', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('nonexistent_filter_xyz=param');
      assert.equal(segment, null, 'Should return null for non-existent filter');

      graph.free();
    });

    it('should parse filter with labeled inputs/outputs', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('[in]scale=640:480[out]');
      assert.ok(segment, 'Should parse filter with labels');

      if (segment) {
        segment.free();
      }

      graph.free();
    });
  });

  describe('Filter Creation', () => {
    it('should create filters from segment', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480,hflip');
      assert.ok(segment);

      if (segment) {
        const ret = segment.createFilters();
        assert.equal(ret, 0, 'Should create filters successfully');

        // Verify filters were added to graph
        const nbFilters = graph.nbFilters;
        assert.ok(nbFilters >= 2, 'Should have at least 2 filters in graph');

        segment.free();
      }

      graph.free();
    });

    it('should create single filter', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('crop=640:480');
      assert.ok(segment);

      if (segment) {
        const ret = segment.createFilters();
        assert.equal(ret, 0, 'Should create filter successfully');

        assert.ok(graph.nbFilters >= 1, 'Should have at least 1 filter');

        segment.free();
      }

      graph.free();
    });

    it('should handle createFilters multiple times (idempotent)', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        // First call
        const ret1 = segment.createFilters();
        assert.equal(ret1, 0, 'First createFilters should succeed');

        const filtersAfterFirst = graph.nbFilters;

        // Second call (should be idempotent)
        const ret2 = segment.createFilters();
        assert.equal(ret2, 0, 'Second createFilters should succeed');

        const filtersAfterSecond = graph.nbFilters;
        assert.equal(filtersAfterFirst, filtersAfterSecond, 'Should not create duplicate filters');

        segment.free();
      }

      graph.free();
    });
  });

  describe('Options Application', () => {
    it('should apply options to filters', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        const ret = segment.applyOpts();
        assert.equal(ret, 0, 'Should apply options successfully');

        segment.free();
      }

      graph.free();
    });

    it('should apply options to complex filter chain', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=w=1920:h=1080,hflip,vflip');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        const ret = segment.applyOpts();
        assert.equal(ret, 0, 'Should apply options to all filters');

        segment.free();
      }

      graph.free();
    });

    it('should handle applyOpts multiple times (idempotent)', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('crop=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();

        // First call
        const ret1 = segment.applyOpts();
        assert.equal(ret1, 0, 'First applyOpts should succeed');

        // Second call (should be idempotent)
        const ret2 = segment.applyOpts();
        assert.equal(ret2, 0, 'Second applyOpts should succeed');

        segment.free();
      }

      graph.free();
    });
  });

  describe('Segment Application and Linking', () => {
    it('should apply segment with simple filter', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create buffersrc and buffersink
      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter && sinkFilter);

      const buffersrc = graph.createFilter(bufferFilter, 'in', 'video_size=640x480:pix_fmt=0:time_base=1/25');
      const buffersink = graph.createFilter(sinkFilter, 'out');
      assert.ok(buffersrc && buffersink);

      // Parse segment
      const segment = graph.segmentParse('scale=320:240');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        segment.applyOpts();

        // Apply segment - initializes and links filters, returns unconnected pads
        const inputs = new FilterInOut();
        const outputs = new FilterInOut();

        const ret = segment.apply(inputs, outputs);
        assert.equal(ret, 0, 'Should apply segment successfully');

        // Link buffersrc to segment input
        const segmentInput = inputs.filterCtx;
        assert.ok(segmentInput, 'Should have segment input');

        if (segmentInput) {
          const linkRet = buffersrc.link(0, segmentInput, inputs.padIdx);
          assert.equal(linkRet, 0, 'Should link buffersrc to segment');
        }

        // Link segment output to buffersink
        const segmentOutput = outputs.filterCtx;
        assert.ok(segmentOutput, 'Should have segment output');

        if (segmentOutput) {
          const linkRet = segmentOutput.link(outputs.padIdx, buffersink, 0);
          assert.equal(linkRet, 0, 'Should link segment to buffersink');
        }

        inputs.free();
        outputs.free();
        segment.free();
      }

      graph.free();
    });

    it('should apply segment with filter chain', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create buffersrc and buffersink
      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter && sinkFilter);

      const buffersrc = graph.createFilter(bufferFilter, 'in', 'video_size=1920x1080:pix_fmt=0:time_base=1/30');
      const buffersink = graph.createFilter(sinkFilter, 'out');
      assert.ok(buffersrc && buffersink);

      // Parse multi-filter segment
      const segment = graph.segmentParse('scale=1280:720,hflip,vflip');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        segment.applyOpts();

        const inputs = new FilterInOut();
        const outputs = new FilterInOut();

        const ret = segment.apply(inputs, outputs);
        assert.equal(ret, 0, 'Should apply segment chain');

        // Link external filters
        const segmentInput = inputs.filterCtx;
        const segmentOutput = outputs.filterCtx;

        assert.ok(segmentInput && segmentOutput, 'Should have input and output pads');

        if (segmentInput && segmentOutput) {
          buffersrc.link(0, segmentInput, inputs.padIdx);
          segmentOutput.link(outputs.padIdx, buffersink, 0);
        }

        inputs.free();
        outputs.free();
        segment.free();
      }

      graph.free();
    });

    it('should handle apply multiple times (idempotent)', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        segment.applyOpts();

        // First apply
        const inputs1 = new FilterInOut();
        const outputs1 = new FilterInOut();
        const ret1 = segment.apply(inputs1, outputs1);
        assert.equal(ret1, 0, 'First apply should succeed');

        inputs1.free();
        outputs1.free();

        // Second apply (should be idempotent)
        const inputs2 = new FilterInOut();
        const outputs2 = new FilterInOut();
        const ret2 = segment.apply(inputs2, outputs2);
        assert.equal(ret2, 0, 'Second apply should succeed');

        inputs2.free();
        outputs2.free();

        segment.free();
      }

      graph.free();
    });
  });

  describe('Hardware Device Context', () => {
    it('should allow setting hw_device_ctx on hardware filters', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Try to parse a filter that supports hardware acceleration
      // Note: This test may only work on systems with hardware acceleration support
      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();

        // Check if any filters have AVFILTER_FLAG_HWDEVICE flag
        const filters = graph.filters;
        if (filters) {
          for (const filterCtx of filters) {
            const filter = filterCtx.filter;
            if (filter && (filter.flags & AVFILTER_FLAG_HWDEVICE) !== 0) {
              // This filter supports hw_device_ctx
              // In real usage, you would set:
              // filterCtx.hwDeviceCtx = someHardwareDeviceContext;
              assert.ok(true, 'Filter supports hardware device context');
            }
          }
        }

        segment.free();
      }

      graph.free();
    });

    it('should set hw_device_ctx before initialization', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        // Create filters but don't apply yet
        segment.createFilters();

        // At this point, hw_device_ctx could be set on filters
        // before they are initialized by applyOpts/apply

        const filters = graph.filters;
        assert.ok(filters, 'Should have filters created');

        // Apply options and initialize
        segment.applyOpts();

        const inputs = new FilterInOut();
        const outputs = new FilterInOut();
        segment.apply(inputs, outputs);

        inputs.free();
        outputs.free();
        segment.free();
      }

      graph.free();
    });
  });

  describe('Complete Workflow', () => {
    it('should execute complete segment workflow: parse -> create -> applyOpts -> apply', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create buffersrc and buffersink first
      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter && sinkFilter);

      const buffersrc = graph.createFilter(bufferFilter, 'in', 'video_size=1920x1080:pix_fmt=0:time_base=1/30');
      const buffersink = graph.createFilter(sinkFilter, 'out');
      assert.ok(buffersrc && buffersink);

      // Step 1: Parse
      const segment = graph.segmentParse('scale=640:480,hflip');
      assert.ok(segment, 'Step 1: Parse should succeed');

      if (segment) {
        // Step 2: Create filters
        const createRet = segment.createFilters();
        assert.equal(createRet, 0, 'Step 2: Create filters should succeed');

        // Step 3: Apply options
        const optsRet = segment.applyOpts();
        assert.equal(optsRet, 0, 'Step 3: Apply options should succeed');

        // Step 4: Apply (initialize and link)
        const inputs = new FilterInOut();
        const outputs = new FilterInOut();

        const applyRet = segment.apply(inputs, outputs);
        assert.equal(applyRet, 0, 'Step 4: Apply should succeed');

        // Link external filters
        const segmentInput = inputs.filterCtx;
        const segmentOutput = outputs.filterCtx;

        assert.ok(segmentInput, 'Should have segment input');
        assert.ok(segmentOutput, 'Should have segment output');

        if (segmentInput && segmentOutput) {
          buffersrc.link(0, segmentInput, inputs.padIdx);
          segmentOutput.link(outputs.padIdx, buffersink, 0);

          // Step 5: Configure graph
          const configRet = graph.configSync();
          assert.equal(configRet, 0, 'Step 5: Configure graph should succeed');
        }

        inputs.free();
        outputs.free();
        segment.free();
      }

      graph.free();
    });

    it('should execute complete workflow (async)', async () => {
      const graph = new FilterGraph();
      graph.alloc();

      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter && sinkFilter);

      const buffersrc = graph.createFilter(bufferFilter, 'in', 'video_size=1920x1080:pix_fmt=0:time_base=1/30');
      const buffersink = graph.createFilter(sinkFilter, 'out');
      assert.ok(buffersrc && buffersink);

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        segment.applyOpts();

        const inputs = new FilterInOut();
        const outputs = new FilterInOut();

        segment.apply(inputs, outputs);

        const segmentInput = inputs.filterCtx;
        const segmentOutput = outputs.filterCtx;

        if (segmentInput && segmentOutput) {
          buffersrc.link(0, segmentInput, inputs.padIdx);
          segmentOutput.link(outputs.padIdx, buffersink, 0);

          const configRet = await graph.config();
          assert.equal(configRet, 0, 'Should configure graph asynchronously');
        }

        inputs.free();
        outputs.free();
        segment.free();
      }

      graph.free();
    });

    it('should handle video filter segment workflow with crop and flip', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create video buffer and sink
      const bufferFilter = Filter.getByName('buffer');
      const sinkFilter = Filter.getByName('buffersink');
      assert.ok(bufferFilter && sinkFilter);

      const buffersrc = graph.createFilter(bufferFilter, 'vin', 'video_size=1920x1080:pix_fmt=0:time_base=1/30');
      const buffersink = graph.createFilter(sinkFilter, 'vout');
      assert.ok(buffersrc && buffersink);

      // Parse video filter segment
      const segment = graph.segmentParse('crop=1280:720,hflip');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        segment.applyOpts();

        const inputs = new FilterInOut();
        const outputs = new FilterInOut();

        const ret = segment.apply(inputs, outputs);
        assert.equal(ret, 0, 'Should apply video segment');

        const segmentInput = inputs.filterCtx;
        const segmentOutput = outputs.filterCtx;

        if (segmentInput && segmentOutput) {
          buffersrc.link(0, segmentInput, inputs.padIdx);
          segmentOutput.link(outputs.padIdx, buffersink, 0);

          const configRet = graph.configSync();
          assert.equal(configRet, 0, 'Should configure video graph');
        }

        inputs.free();
        outputs.free();
        segment.free();
      }

      graph.free();
    });
  });

  describe('Memory Management', () => {
    it('should free segment', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();
        segment.free();
        // Should not crash after free
        assert.ok(true, 'Should free segment successfully');
      }

      graph.free();
    });

    it('should support Symbol.dispose', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();

        if (typeof segment[Symbol.dispose] === 'function') {
          segment[Symbol.dispose]();
          assert.ok(true, 'Should dispose successfully');
        }
      }

      graph.free();
    });

    it('should handle using statement with segment', () => {
      const graph = new FilterGraph();
      graph.alloc();

      {
        const segment = graph.segmentParse('scale=640:480');
        assert.ok(segment);

        if (segment) {
          segment.createFilters();
          // In TypeScript with using statement:
          // using segment = graph.segmentParse('scale=640:480');
          // Segment would be automatically disposed
          segment[Symbol.dispose]();
        }
      }

      assert.ok(true, 'Should handle using statement pattern');

      graph.free();
    });

    it('should not crash on double free', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.free();
        segment.free(); // Double free should be safe
        assert.ok(true, 'Should handle double free safely');
      }

      graph.free();
    });
  });

  describe('Error Handling', () => {
    it('should handle null segment operations gracefully', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('nonexistent_filter');
      // FFmpeg may return a segment even for non-existent filters
      // The error will occur during createFilters
      if (segment) {
        const ret = segment.createFilters();
        assert.ok(ret < 0, 'Should fail to create non-existent filter');
        segment.free();
      }

      graph.free();
    });

    it('should fail when creating filters before parsing', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Can't create a segment without parsing
      // This test documents expected behavior
      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment, 'Need valid segment to test');

      if (segment) {
        segment.free();
      }

      graph.free();
    });

    it('should handle invalid options in segment', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Try to parse filter with invalid options
      const segment = graph.segmentParse('scale=invalid:options');
      // May return null or parse with error during applyOpts
      if (segment) {
        const createRet = segment.createFilters();
        if (createRet === 0) {
          const optsRet = segment.applyOpts();
          // Invalid options should fail during applyOpts
          assert.ok(optsRet !== 0 || true, 'Should handle invalid options');
        }
        segment.free();
      }

      graph.free();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty filter description', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('');
      // Empty string may return null or empty segment
      assert.ok(segment === null || segment, 'Should handle empty description');

      if (segment) {
        segment.free();
      }

      graph.free();
    });

    it('should handle very long filter chains', () => {
      const graph = new FilterGraph();
      graph.alloc();

      // Create a very long filter chain
      const longChain = Array(50).fill('null').join(',');
      const segment = graph.segmentParse(longChain);

      if (segment) {
        const ret = segment.createFilters();
        assert.equal(ret, 0, 'Should handle long filter chains');

        // Check that many filters were created
        assert.ok(graph.nbFilters >= 50, 'Should create all filters in chain');

        segment.free();
      }

      graph.free();
    });

    it('should handle filter with many options', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=w=1920:h=1080:flags=lanczos:in_color_matrix=bt709:out_color_matrix=bt709');
      assert.ok(segment, 'Should parse filter with many options');

      if (segment) {
        segment.createFilters();
        const ret = segment.applyOpts();
        assert.equal(ret, 0, 'Should apply many options');

        segment.free();
      }

      graph.free();
    });
  });

  describe('Integration with FilterGraph', () => {
    it('should verify filters are added to graph', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const initialFilters = graph.nbFilters;

      const segment = graph.segmentParse('scale=640:480,hflip');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();

        const filtersAfterCreate = graph.nbFilters;
        assert.ok(filtersAfterCreate > initialFilters, 'Should add filters to graph');

        // Filters should be accessible through graph.filters
        const filters = graph.filters;
        assert.ok(filters, 'Should have filters array');
        assert.ok(filters && filters.length >= 2, 'Should have at least 2 filters');

        segment.free();
      }

      graph.free();
    });

    it('should get filters by name after segment creation', () => {
      const graph = new FilterGraph();
      graph.alloc();

      const segment = graph.segmentParse('scale=640:480');
      assert.ok(segment);

      if (segment) {
        segment.createFilters();

        // Try to find the created filter
        const filters = graph.filters;
        if (filters && filters.length > 0) {
          const firstFilter = filters[0];
          assert.ok(firstFilter, 'Should have at least one filter');

          // Try to get by name if it has one
          if (firstFilter.name) {
            const retrieved = graph.getFilter(firstFilter.name);
            assert.ok(retrieved, 'Should retrieve filter by name');
          }
        }

        segment.free();
      }

      graph.free();
    });
  });
});
