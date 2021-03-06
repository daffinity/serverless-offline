'use strict';

const Velocity = require('velocityjs');
const isPlainObject = require('lodash.isplainobject');

const debugLog = require('./debugLog');

const Compile = Velocity.Compile;
const parse = Velocity.parse;

/* 
  Deeply traverses a plain object's keys (the serverless template, previously JSON)
  When it finds a string, assumes it's Velocity language and renders it.
*/
module.exports = function renderVelocityTemplateObject(templateObject, context) {
  
  const result = {};
  let toProcess = templateObject;
  
  // In some projects, the template object is a string, let us see if it's JSON
  if (typeof toProcess === 'string') toProcess = tryToParseJSON(toProcess);
  
  // Let's check again
  if (isPlainObject(toProcess)) {
    for (let key in toProcess) {
      
      const value = toProcess[key];
      debugLog('Processing key:', key, '- value:', value);
      
      if (typeof value === 'string') result[key] = renderVelocityString(value, context);
      
      // Go deeper
      else if (isPlainObject(value)) result[key] = renderVelocityTemplateObject(value, context);
        
      // This should never happen: value should either be a string or a plain object
      else result[key] = value;
    }
  }
  
  // Still a string? Maybe it's some complex Velocity stuff
  else if (typeof toProcess === 'string') {
    
    // If the plugin threw here then you should consider reviewing your template or posting an issue.
    const alternativeResult = tryToParseJSON(renderVelocityString(toProcess, context));
    
    return isPlainObject(alternativeResult) ? alternativeResult : result;
  }
  
  return result;
};

function renderVelocityString(velocityString, context) {
  
  // This line can throw, but this function does not handle errors
  // Quick args explanation:
  // { escape: false } --> otherwise would escape &, < and > chars with html (&amp;, &lt; and &gt;)
  // render(context, null, true) --> null: no custom macros; true: silent mode, just like APIG
  const renderResult = (new Compile(parse(velocityString), { escape: false })).render(context, null, true);
  
  debugLog('Velocity rendered:', renderResult || 'undefined');
  
  switch (renderResult) {
    
    case 'undefined':
      return undefined;
      
    case 'null':
      return null;
      
    case 'true':
      return true;
      
    case 'false':
      return false;
      
    default:
      return tryToParseJSON(renderResult);
  }
}

function tryToParseJSON(string) {
  let parsed;
  try {
    parsed = JSON.parse(string);
  }
  catch (err) {
    // nothing! Some things are not meant to be parsed.
  }
  finally {
    return parsed || string;
  }
}
