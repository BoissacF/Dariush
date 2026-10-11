(function(){
  "use strict";

  // ---------- état ----------
  let counter = 0;
  const nodes = [];   // {id,label,shape,color,fontSize,size}
  const edges = [];   // {id,fromId,toId,weight}
  let selectedId = null;
  let edgeCounter = 0;

  // Formes communes à Mermaid ET NetworkX
  const SHAPES = [
    ["circle","Cercle"],["rect","Carré"],["triangle","Triangle"],
    ["diamond","Losange"],["hex","Hexagone"]
  ];

  // ---------- helpers DOM ----------
  const $ = (s)=>document.querySelector(s);
  function el(tag,attrs,kids){
    const e=document.createElement(tag);
    if(attrs) for(const k in attrs){
      if(k==="class")e.className=attrs[k];
      else if(k==="text")e.textContent=attrs[k];
      else if(k.startsWith("on"))e.addEventListener(k.slice(2),attrs[k]);
      else if(attrs[k]!=null)e.setAttribute(k,attrs[k]);
    }
    (kids||[]).forEach(c=>e.appendChild(typeof c==="string"?document.createTextNode(c):c));
    return e;
  }
  const nodeById = (id)=>nodes.find(n=>n.id===id);
  const labelOf = (n)=> (n && n.label) ? n.label : "";
  const isDirected = ()=> ($("#graphMode").value === "directed");

  // ---------- actions sommets ----------
  function addNode(){
    counter++;
    const n={id:"n"+counter,label:"",shape:"circle",color:"#cdddff",fontSize:16,size:8};
    nodes.push(n);
    selectedId=n.id;          // on ouvre directement le nouveau sommet
    renderEditor(); schedulePreview();
  }
  function deleteNode(id){
    const i=nodes.findIndex(n=>n.id===id);
    if(i>=0)nodes.splice(i,1);
    for(let k=edges.length-1;k>=0;k--){
      if(edges[k].fromId===id||edges[k].toId===id)edges.splice(k,1);
    }
    if(selectedId===id)selectedId=null;
    renderEditor(); schedulePreview();
  }
  function addEdge(fromId){
    const others=nodes.filter(n=>n.id!==fromId);
    edgeCounter++;
    edges.push({id:"e"+edgeCounter,fromId,toId:others.length?others[0].id:"",weight:"NULL"});
    renderDetail(); schedulePreview();
  }
  function deleteEdge(edgeId){
    const i=edges.findIndex(e=>e.id===edgeId);
    if(i>=0)edges.splice(i,1);
    renderDetail(); schedulePreview();
  }

  // ---------- rendu de l'éditeur ----------
  function renderEditor(){
    if(selectedId && nodeById(selectedId)){ renderDetail(); }
    else { renderList(); }
  }

  function renderList(){
    $("#detailView").style.display="none";
    $("#listView").style.display="";
    const list=$("#nodesList"); list.innerHTML="";
    $("#emptyHint").style.display = nodes.length ? "none" : "";

    nodes.forEach(n=>{
      const glyph=el("span",{class:"glyph "+n.shape});
      glyph.style.setProperty("--dot",n.color);
      const name= labelOf(n)
        ? el("span",{class:"name",text:labelOf(n)})
        : el("span",{class:"name empty",text:"étiquette ?"});
      const open=el("button",{class:"node-open",title:"Configurer ce sommet",
        onclick:()=>{selectedId=n.id;renderEditor();}},[glyph,name]);
      const del=el("button",{class:"danger",text:"Supprimer",onclick:()=>deleteNode(n.id)});
      list.appendChild(el("div",{class:"node-row"},[open,del]));
    });
  }

  function renderDetail(){
    const n=nodeById(selectedId);
    if(!n){selectedId=null;renderList();return;}
    $("#listView").style.display="none";
    const v=$("#detailView"); v.style.display=""; v.innerHTML="";

    const back=el("button",{class:"back",text:"← Retour à la liste",
      onclick:()=>{selectedId=null;renderEditor();}});

    // -- champs principaux --
    const labelInput=el("input",{type:"text",value:n.label,placeholder:"Label du sommet"});
    labelInput.addEventListener("input",()=>{n.label=labelInput.value;schedulePreview();});

    const shapeSel=el("select",{},SHAPES.map(([v0,t])=>{
      const o=el("option",{value:v0,text:t}); if(n.shape===v0)o.selected=true; return o;
    }));
    shapeSel.addEventListener("change",()=>{n.shape=shapeSel.value;schedulePreview();});

    const colorInput=el("input",{type:"color",value:n.color});
    colorInput.addEventListener("input",()=>{n.color=colorInput.value;schedulePreview();});

    const fontInput=el("input",{type:"number",min:"8",max:"60",value:n.fontSize});
    fontInput.addEventListener("input",()=>{n.fontSize=clamp(+fontInput.value||16,8,60);schedulePreview();});

    const sizeInput=el("input",{type:"number",min:"0",max:"80",value:n.size});
    sizeInput.addEventListener("input",()=>{n.size=clamp(+sizeInput.value||0,0,80);schedulePreview();});

    const grid=el("div",{class:"grid"},[
      labeled("Label",labelInput,true),
      labeled("Forme",shapeSel),
      labeled("Couleur",colorInput),
      labeled("Taille police (px)",fontInput),
      labeled("Taille sommet — marge (px)",sizeInput)
    ]);

    // -- arêtes --
    const directed=isDirected();
    const edgeFs=el("fieldset");
    edgeFs.appendChild(el("legend",{text: directed ? "Arêtes partant de ce sommet" : "Arêtes de ce sommet"}));
    // en non orienté : toutes les arêtes qui touchent le sommet ; en orienté : seulement les sortantes
    const myEdges=edges.filter(e=> directed ? (e.fromId===n.id) : (e.fromId===n.id||e.toId===n.id));
    if(!myEdges.length){
      edgeFs.appendChild(el("p",{class:"edge-empty",text:"Aucune arête. Ajoute-en une ci-dessous."}));
    }
    myEdges.forEach(e=>edgeFs.appendChild(edgeRow(e,n.id,directed)));
    const addEdgeBtn=el("button",{class:"ghost",text:"+ Ajouter une arête",
      onclick:()=> nodes.length<2 ? alert("Crée au moins deux sommets pour relier une arête.") : addEdge(n.id)});
    edgeFs.appendChild(addEdgeBtn);

    const delNode=el("button",{class:"danger",text:"Supprimer ce sommet",onclick:()=>deleteNode(n.id)});
    const delWrap=el("div",{class:"node-action"},[delNode]);

    v.appendChild(back);
    v.appendChild(grid);
    v.appendChild(edgeFs);
    v.appendChild(delWrap);
  }

  function edgeRow(e,currentId,directed){
    // "autre extrémité" du point de vue du sommet courant
    const otherId = directed ? e.toId : (e.fromId===currentId ? e.toId : e.fromId);
    const targets=nodes.filter(n=>n.id!==currentId);
    const sel=el("select",{},targets.map(t=>{
      const txt=labelOf(t)||"(sans étiquette)";
      const o=el("option",{value:t.id,text:txt}); if(otherId===t.id)o.selected=true; return o;
    }));
    sel.addEventListener("change",()=>{
      if(directed){ e.toId=sel.value; }
      else {
        // on modifie le bon côté selon d'où on regarde l'arête
        if(e.fromId===currentId) e.toId=sel.value; else e.fromId=sel.value;
      }
      schedulePreview();
    });

    const w=el("input",{type:"text",value:e.weight,title:"Remplace NULL par un poids pour pondérer"});
    w.addEventListener("input",()=>{e.weight=w.value;schedulePreview();});

    const del=el("button",{class:"danger del-edge",text:"Supprimer l'arête",
      title:"Supprimer cette arête",onclick:()=>deleteEdge(e.id)});

    const fld1=labeledInline(directed ? "vers le sommet" : "arête avec",sel); fld1.classList.add("grow");
    const fld2=labeledInline("poids",w); w.classList.add("w");

    const row=el("div",{class:"edge-item"});
    row.appendChild(fld1);
    row.appendChild(fld2);
    row.appendChild(del);
    return row;
  }

  function labeled(text,control,full){
    const l=el("label",{class:"field"+(full?" full":"")},[text]); l.appendChild(control);
    if(full)l.classList.add("full"); return l;
  }
  function labeledInline(text,control){
    const l=el("label",{class:"field"},[text]); l.appendChild(control); return l;
  }
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const isNum=(s)=> s!=="" && !isNaN(s) && !isNaN(parseFloat(s));

  // ============================================================
  //   GÉNÉRATION MERMAID  (pour le markdown : formes + couleurs)
  // ============================================================
  function esc(s){return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function labelHtml(n){
    const pad=Math.max(0,Math.round(n.size));
    const text=esc(labelOf(n)||"?");
    return "<div style='display:inline-block;padding:"+pad+"px;font-size:"+n.fontSize+"px;line-height:1.15'>"+text+"</div>";
  }
  function nodeDecl(n){
    // Le triangle utilise la syntaxe moderne de Mermaid v11 (pas de label HTML,
    // donc la "taille sommet" ne s'applique pas à cette forme).
    if(n.shape==="triangle"){
      return n.id+'@{ shape: triangle, label: "'+esc(labelOf(n)||"?")+'" }';
    }
    const L='"'+labelHtml(n)+'"';
    switch(n.shape){
      case "circle": return n.id+"(("+L+"))";
      case "diamond":return n.id+"{"+L+"}";
      case "hex":    return n.id+"{{"+L+"}}";
      default:       return n.id+"["+L+"]";   // "rect" = carré/rectangle
    }
  }
  function buildMermaid(){
    const dir=$("#direction").value||"TD";
    const directed=isDirected();
    const conn=directed?"-->":"---";
    const lines=["graph "+dir];
    nodes.forEach(n=>lines.push("  "+nodeDecl(n)));
    const seen=new Set();
    edges.forEach(e=>{
      if(!e.toId||!nodeById(e.toId)||!nodeById(e.fromId)||e.fromId===e.toId)return;
      const key=directed ? (e.fromId+">"+e.toId) : [e.fromId,e.toId].slice().sort().join("~");
      if(seen.has(key))return; seen.add(key);
      const wRaw=(e.weight==null?"":String(e.weight)).trim();
      const hasW=wRaw!=="" && wRaw.toUpperCase()!=="NULL";
      lines.push("  "+e.fromId+" "+conn+(hasW?"|"+wRaw+"|":"")+" "+e.toId);
    });
    nodes.forEach(n=>{
      lines.push("  classDef c_"+n.id+" fill:"+n.color+",stroke:#33415a,stroke-width:1px,color:#0f172a;");
    });
    nodes.forEach(n=>lines.push("  class "+n.id+" c_"+n.id+";"));
    return lines.join("\n");
  }

  // ============================================================
  //   GÉNÉRATION PYTHON / NETWORKX  (code épuré : structure seule)
  // ============================================================
  function pyStr(s){ return JSON.stringify(String(s)); } // littérale Python valide
  function pyNames(){
    const used=new Set(); const map={};
    nodes.forEach(n=>{
      let base=(n.label && n.label.trim()) ? n.label.trim() : n.id;
      let name=base,k=2;
      while(used.has(name)){ name=base+"_"+k; k++; }
      used.add(name); map[n.id]=name;
    });
    return map;
  }
  function buildNetworkX(){
    const directed=isDirected();
    const name=pyNames();
    const L=[];
    L.push("import networkx as nx");
    L.push("import matplotlib.pyplot as plt");
    L.push("");
    L.push("G = nx."+(directed?"DiGraph":"Graph")+"()");
    L.push("");
    if(nodes.length){
      L.push("# Sommets");
      nodes.forEach(n=>L.push("G.add_node("+pyStr(name[n.id])+")"));
      L.push("");
    }
    const seen=new Set(); const eLines=[]; let anyWeight=false;
    edges.forEach(e=>{
      if(!e.toId||!name[e.fromId]||!name[e.toId]||e.fromId===e.toId)return;
      const key=directed ? (e.fromId+">"+e.toId) : [e.fromId,e.toId].slice().sort().join("~");
      if(seen.has(key))return; seen.add(key);
      const a=pyStr(name[e.fromId]), b=pyStr(name[e.toId]);
      const wRaw=(e.weight==null?"":String(e.weight)).trim();
      const hasW=wRaw!=="" && wRaw.toUpperCase()!=="NULL";
      if(hasW){ anyWeight=true; const wv=isNum(wRaw)?wRaw:pyStr(wRaw); eLines.push("G.add_edge("+a+", "+b+", weight="+wv+")"); }
      else eLines.push("G.add_edge("+a+", "+b+")");
    });
    if(eLines.length){ L.push("# Arêtes"); eLines.forEach(l=>L.push(l)); L.push(""); }
    L.push("# Affichage");
    L.push("pos = nx.spring_layout(G)");
    L.push('nx.draw(G, pos, with_labels=True, node_color="lightblue", node_size=800)');
    if(anyWeight){
      L.push('labels = nx.get_edge_attributes(G, "weight")');
      L.push("nx.draw_networkx_edge_labels(G, pos, edge_labels=labels)");
    }
    L.push("plt.show()");
    return L.join("\n");
  }

  // ---------- aperçu + sorties ----------
  let mermaidReady=false;
  function ensureMermaid(){
    if(mermaidReady)return true;
    if(typeof window.mermaid==="undefined")return false;
    window.mermaid.initialize({startOnLoad:false,securityLevel:"loose",theme:"default",flowchart:{htmlLabels:true}});
    mermaidReady=true;return true;
  }

  let timer=null;
  function schedulePreview(){
    clearTimeout(timer);
    timer=setTimeout(updateOutput,250);
  }
  function updateOutput(){
    const code=buildMermaid();
    $("#code").value="```mermaid\n"+code+"\n```";
    $("#codePy").value=buildNetworkX();

    const prev=$("#preview");
    if(!nodes.length){prev.innerHTML='<div class="preview-msg">Ajoute un sommet pour voir le graphe.</div>';return;}
    if(!ensureMermaid()){prev.innerHTML='<div class="preview-msg">Chargement de Mermaid…</div>';setTimeout(updateOutput,400);return;}

    const id="mmd-"+Date.now();
    let p;
    try{ p=window.mermaid.render(id,code); }
    catch(err){ showErr(prev,id); return; }
    Promise.resolve(p)
      .then(res=>{ prev.innerHTML = (res&&res.svg)?res.svg:""; if(!res||!res.svg)showErr(prev,id); })
      .catch(()=>showErr(prev,id));
  }
  function showErr(prev,id){
    document.getElementById(id)?.remove();
    document.getElementById("d"+id)?.remove();
    prev.innerHTML='<div class="preview-msg err">Graphe incomplet ou invalide — vérifie les arêtes.</div>';
  }

  // ---------- copie ----------
  function bindCopy(btnId, areaId, doneId){
    $(btnId).addEventListener("click",async()=>{
      try{ await navigator.clipboard.writeText($(areaId).value); }
      catch(_){ $(areaId).select(); document.execCommand("copy"); }
      const c=$(doneId); c.hidden=false; setTimeout(()=>c.hidden=true,1400);
    });
  }
  bindCopy("#copyBtn","#code","#copied");
  bindCopy("#copyPyBtn","#codePy","#copiedPy");

  // ---------- branchements ----------
  $("#addNode").addEventListener("click",addNode);
  $("#direction").addEventListener("change",schedulePreview);
  $("#graphMode").addEventListener("change",()=>{ renderEditor(); schedulePreview(); });

  renderEditor();
  updateOutput();
})();