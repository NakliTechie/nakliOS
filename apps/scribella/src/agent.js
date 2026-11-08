// The agent panel: a conversation with the NakliOS model that can read the project, search it, build it and propose
// edits. It never writes: an edit becomes a proposal the person accepts or rejects, like any revision.
export const MAX_STEPS = 8;

export const AGENT_TOOLS = [
  { name:'list_files', description:'List the files in the project.', parameters:{ type:'object', properties:{} } },
  { name:'read_file', description:'Read a text file of the project.', parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:['path'] } },
  { name:'search', description:'Search the project text files.', parameters:{ type:'object', properties:{ query:{ type:'string' } }, required:['query'] } },
  { name:'build', description:'Compile the paper and report errors.', parameters:{ type:'object', properties:{} } },
  { name:'propose_edit', description:'Propose replacing one exact passage of a file. The person decides. `find` must appear exactly once in the file.', parameters:{ type:'object', properties:{ path:{ type:'string' }, find:{ type:'string' }, replace:{ type:'string' }, reason:{ type:'string' } }, required:['path', 'find', 'replace'] } },
].map(tool => ({ type:'function', function:tool }));

export const SYSTEM = 'You help a researcher with their LaTeX paper. Use the tools to look before you answer. Never invent citations, results or numbers. To change the paper, call propose_edit; the researcher accepts or rejects each edit. Keep replies short.';

// `ask(messages, tools)` answers an OpenAI-style message; `run(name, args)` answers a tool's result as text.
export async function agentTurn(history, { ask, run, onStep = () => {} }) {
  const messages = [...history];
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const reply = await ask(messages, AGENT_TOOLS);
    messages.push(reply);
    const calls = reply.tool_calls || [];
    if (!calls.length) return { messages, text:reply.content || '' };
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
      onStep(call.function.name, args);
      let result;
      try { result = await run(call.function.name, args); } catch (error) { result = `Error: ${error.message}`; }
      messages.push({ role:'tool', tool_call_id:call.id, content:typeof result === 'string' ? result : JSON.stringify(result).slice(0, 12000) });
    }
  }
  return { messages, text:'I stopped after eight steps. Ask again to continue.' };
}
