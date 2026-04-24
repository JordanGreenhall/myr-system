'use strict';

const { program } = require('commander');
const fs = require('fs');
const { getDb } = require('./db');
const { synthesize, validateSynthesisRequest } = require('../lib/synthesis');

program
  .name('myr-synthesize')
  .description('Cross-node synthesis of MYR yield by domain')
  .option('--tags <tags>', 'Comma-separated domain tags to match')
  .option('--min-nodes <n>', 'Minimum contributing nodes for a cluster (default 2)', parseInt, 2)
  .option('--out <path>', 'Write synthesis report to file');

program.parse();
const opts = program.opts();

function main() {
  if (!opts.tags) {
    console.error('Provide --tags "tag1,tag2" to specify domains for synthesis.');
    process.exit(1);
  }

  const db = getDb();
  const validation = validateSynthesisRequest({ tags: opts.tags, minNodes: opts.minNodes });
  if (!validation.valid) {
    console.error(validation.error);
    db.close();
    process.exit(1);
  }

  const result = synthesize(db, {
    tags: validation.tags,
    minNodes: opts.minNodes || 2,
    store: true,
  });
  const md = result.markdown;

  db.close();

  if (opts.out) {
    fs.writeFileSync(opts.out, md, 'utf8');
    console.log(`Synthesis written to ${opts.out}`);
  } else {
    console.log(md);
  }
}

main();
