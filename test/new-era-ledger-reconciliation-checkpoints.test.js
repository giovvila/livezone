import test from 'node:test';
import {ledgerReconciliationBoundaries,verifyLedgerReconciliationCase} from '../test-support/EraLedgerReconciliationCases.js';

// A sequential parent stops at the first failed assertion. Each subtest owns a
// fresh TEMP fixture and reaches the actual production hook in a child process.
test('thirteen Ledger reconciliation checkpoints preserve the existing recovery contract',async t=>{
    for(const boundary of ledgerReconciliationBoundaries){
        let failure;
        await t.test(boundary,async()=>{
            try{await verifyLedgerReconciliationCase(boundary,{
                native:process.env.LZ_TEST_NATIVE_DURABILITY==='1',evidenceDirectory:process.env.LZ_ERA16B_EVIDENCE_DIRECTORY});}
            catch(error){failure=error;throw error;}
        });
        if(failure)throw failure;
    }
});
