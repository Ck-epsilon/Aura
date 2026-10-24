import { suite as bytes } from './bytes.mjs';
import { suite as edit } from './edit.mjs';
import { suite as stale } from './stale.mjs';
import { suite as multi } from './multi.mjs';
import { suite as tx } from './tx.mjs';
import { suite as read } from './read.mjs';
import { suite as mcp } from './mcp.mjs';
import { suite as fuzz } from './fuzz.mjs';
import { suite as baseline } from './baseline.mjs';

export const suites = [bytes, edit, stale, multi, tx, read, mcp, fuzz, baseline];
