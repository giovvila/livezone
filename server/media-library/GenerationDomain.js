export const isGeneration=value=>Number.isSafeInteger(value)&&value>=1;

export function successorGeneration(current,invalidCode){
    if(!isGeneration(current))throw Object.assign(Error(invalidCode),{code:invalidCode});
    if(current===Number.MAX_SAFE_INTEGER)throw Object.assign(Error('GENERATION_EXHAUSTED'),{code:'GENERATION_EXHAUSTED'});
    return current+1;
}
