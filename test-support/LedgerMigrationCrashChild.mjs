import {migrationFixture} from './CleanLedgerMigrationFixture.mjs';
const [root,point]=process.argv.slice(2);
await migrationFixture(root,{hook:stage=>{if(stage===point)process.exit(77);}}).start();
throw Error('Migration crash boundary was not reached: '+point);
