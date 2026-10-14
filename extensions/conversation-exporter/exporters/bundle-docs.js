// Shared by both providers. The schema also ships as conversation.schema.json.
function conversationExportSchema() {
  const nullableString = {type:['string','null']};
  const time = {type:['string','number','null']};
  return {
    $schema:'https://json-schema.org/draft/2020-12/schema',
    title:'Conversation export',
    description:'Segment tree: each node holds only its local messages. Read ancestors before a child branch.',
    $ref:'#/$defs/node',
    $defs:{
      counts:{type:'object', properties:Object.fromEntries(['messages','user','assistant','files','branchPoints','leafBranches'].map(k => [k,{type:'integer', minimum:0}]))},
      file:{type:'object', properties:{id:nullableString, name:{type:'string'}, source:{type:'string'}, messageId:nullableString,
        messageIndex:{type:['integer','null']}, branchPath:{type:'array', items:{type:'integer'}}, size:{type:['number','null']},
        mime:{type:'string'}, path:{type:'string'}}},
      inventory:{type:'object', required:['stage','files','artifacts','discoveryFailures'], properties:{stage:{const:'discovery'}, files:{type:'array',items:{type:'object',properties:{id:{type:'string'},name:{type:'string'},copyEligible:{type:'boolean'},error:nullableString,associations:{type:'array',items:{type:'object'}}}}}, artifacts:{type:'array',items:{type:'object'}}, discoveryFailures:{type:'array',items:{type:'object'}}}},
      block:{type:'object', required:['type'], properties:{type:{type:'string'}, text:{type:'string'}, thinking:{type:'string'},
        name:{type:'string'}, id:{type:'string'}, tool_use_id:{type:'string'}, input:{}, content:{}, is_error:{type:'boolean'}}},
      message:{type:'object', required:['index','id','role','text','files'], properties:{index:{type:'integer',minimum:0},
        id:nullableString, role:{enum:['user','assistant']}, model:nullableString, create_time:time, text:{type:'string'},
        files:{type:'array',items:{$ref:'#/$defs/file'}}, blocks:{type:'array',items:{$ref:'#/$defs/block'}}}},
      node:{type:'object', required:['exportedAt','source','exportMode','conversationId','messages','files'], properties:{
        exportedAt:{type:'string'}, source:{enum:['claude-api','backend-api','claude-dom-fallback']},
        exportMode:{enum:['all-branches','current-branch']}, branchStructure:{const:'segment-tree'},
        url:{type:'string'}, conversationId:nullableString, organizationId:{type:'string'}, title:{type:'string'},
        create_time:time, update_time:time, branchPath:{type:'array',items:{type:'integer',minimum:1}},
        branchIndex:{type:['integer','null'],minimum:0}, branchLabel:nullableString, parentMessageId:nullableString,
        startMessageId:nullableString, recovery:nullableString, warnings:{type:'array',items:{type:'string'}},
        counts:{$ref:'#/$defs/counts'}, localCounts:{$ref:'#/$defs/counts'}, totalCounts:{$ref:'#/$defs/counts'},
        fileInventory:{$ref:'#/$defs/inventory'},
        messages:{type:'array',items:{$ref:'#/$defs/message'}}, files:{type:'array',items:{$ref:'#/$defs/file'}},
        branches:{type:'array',items:{$ref:'#/$defs/node'}}},
        allOf:[{if:{properties:{exportMode:{const:'all-branches'}}},then:{required:['branchStructure','branchPath','branches','localCounts','totalCounts']}}]}
    }
  };
}
async function addConversationBundleDocs(zip, provider, history) {
  if (history) await addJsonZipEntry(zip, 'conversation.schema.json', conversationExportSchema());
  const lines = ['# Conversation export', '',
    ...(history ? ['- `conversation.json`: all branches; each node contains local messages. Read ancestor messages before each child branch.',
      '- `conversation.schema.json`: JSON Schema for the conversation.', '- `files/`: downloaded content.'] : ['- Downloaded content is at the ZIP root.']),
    '- `export-failures.json`: unresolved downloads (when present).',
    ...(provider === 'claude' ? ['- `export-manifest.json`: identities, message/branch links, routes, byte counts, SHA-256, copy cleanup, discovery gaps.',
      `- \`${history ? 'files/' : ''}artifacts/<id>/<version>/\`: published source; \`${history ? 'files/' : ''}recorded-source/\`: reconstructed Write/Edit evidence, not exact delivered bytes.`,
      '- Built-in Artifact.quickstart template instructions/catalogue are replaced by an omission marker.',
      '- Missing source access may require a temporary account copy. Only copies created in this run can be deleted; retained copies are reported.'] : []),
    '', 'A ZIP does not prove completeness. Check failures' + (provider === 'claude' ? ' and manifest discovery gaps.' : '.')];
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  await zip.addEntry({name:'README.md', parts:[bytes], size:bytes.length, crc:crc32(bytes), lastModified:new Date()});
}

// Reserve exporter-owned root names before adding user files to a files-only ZIP.
function reserveConversationBundlePaths(files, history) {
  if (history) return;
  const used = new Set(['readme.md', 'conversation.schema.json', 'export-manifest.json', 'export-failures.json']);
  for (const file of files) {
    const base = file.zipPath || file.downloadName || file.name || 'file';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const dot = base.lastIndexOf('.');
      name = dot > base.lastIndexOf('/') ? `${base.slice(0,dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
    }
    used.add(name.toLowerCase());
    if (file.zipPath) file.zipPath = name;
    file.downloadName = name;
  }
}

// ZIP method 8 is standard raw Deflate. Keep already-compressed files stored.
async function compressConversationZipParts(parts, size, name) {
  const stored = {parts, method:0, compressedSize:size};
  if (size < 1024 || typeof CompressionStream !== 'function'
      || /\.(zip|gz|bz2|xz|zst|7z|rar|png|jpe?g|gif|webp|avif|mp[34]|webm|woff2?)$/i.test(name)) return stored;
  try {
    const stream = new Blob(parts).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return compressed.length < size ? {parts:[compressed], method:8, compressedSize:compressed.length} : stored;
  } catch {
    // Compression availability must not prevent a valid archive from being saved.
    return stored;
  }
}
