var i={agents:[],messages:[],currentChannel:"general",currentThread:null,isConnected:!1,ws:null,reconnectAttempts:0},E=[];function V(t){return E.push(t),()=>{let e=E.indexOf(t);e>-1&&E.splice(e,1)}}function w(){E.forEach(t=>t())}function F(t){i.agents=t,w()}function U(t){i.messages=t,w()}function z(t){i.currentChannel=t,w()}function x(t){i.isConnected=t,t&&(i.reconnectAttempts=0),w()}function W(){i.reconnectAttempts++}function _(t){i.ws=t}function J(){let{messages:t,currentChannel:e}=i;return e==="general"?t:t.filter(n=>n.from===e||n.to===e)}function A(t){i.currentThread=t}function Q(t){return i.messages.filter(e=>e.thread===t)}function Y(t){return i.messages.filter(e=>e.thread===t).length}var G=null;function I(){let t=window.location.protocol==="https:"?"wss:":"ws:",e=new WebSocket(`${t}//${window.location.host}/ws`);e.onopen=()=>{x(!0)},e.onclose=()=>{x(!1);let n=Math.min(1e3*Math.pow(2,i.reconnectAttempts),3e4);W(),setTimeout(I,n)},e.onerror=n=>{console.error("WebSocket error:",n)},e.onmessage=n=>{try{let s=JSON.parse(n.data);he(s)}catch(s){console.error("Failed to parse message:",s)}},_(e)}function he(t){console.log("[WS] Received data:",{agentCount:t.agents?.length,messageCount:t.messages?.length}),t.agents&&(console.log("[WS] Setting agents:",t.agents.map(e=>e.name)),F(t.agents)),t.messages&&U(t.messages),G&&G(t)}async function T(t,e,n){try{let s={to:t,message:e};n&&(s.thread=n);let o=await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(s)}),r=await o.json();return o.ok&&r.success?{success:!0}:{success:!1,error:r.error||"Failed to send message"}}catch{return{success:!1,error:"Network error - could not send message"}}}function L(t){if(!t)return!1;let e=Date.parse(t);return Number.isNaN(e)?!1:Date.now()-e<3e4}function l(t){if(!t)return"";let e=document.createElement("div");return e.textContent=t,e.innerHTML}function C(t){return new Date(t).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}function X(t){let e=new Date(t),n=new Date,s=new Date(n);return s.setDate(s.getDate()-1),e.toDateString()===n.toDateString()?"Today":e.toDateString()===s.toDateString()?"Yesterday":e.toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}function h(t){let e=["#e01e5a","#2bac76","#e8a427","#1264a3","#7c3aed","#0d9488","#dc2626","#9333ea","#ea580c","#0891b2"],n=0;for(let s=0;s<t.length;s++)n=t.charCodeAt(s)+((n<<5)-n);return e[Math.abs(n)%e.length]}function v(t){return t.substring(0,2).toUpperCase()}function k(t){if(!t)return"";let e=l(t);return e=e.replace(/```([\s\S]*?)```/g,"<pre>$1</pre>"),e=e.replace(/`([^`]+)`/g,"<code>$1</code>"),e=e.replace(/\n/g,"<br>"),e}var ee=[],a,c=-1;function te(){return a={connectionDot:document.getElementById("connection-dot"),channelsList:document.getElementById("channels-list"),agentsList:document.getElementById("agents-list"),messagesList:document.getElementById("messages-list"),currentChannelName:document.getElementById("current-channel-name"),channelTopic:document.getElementById("channel-topic"),onlineCount:document.getElementById("online-count"),messageInput:document.getElementById("message-input"),sendBtn:document.getElementById("send-btn"),boldBtn:document.getElementById("bold-btn"),emojiBtn:document.getElementById("emoji-btn"),searchTrigger:document.getElementById("search-trigger"),commandPaletteOverlay:document.getElementById("command-palette-overlay"),paletteSearch:document.getElementById("palette-search"),paletteResults:document.getElementById("palette-results"),paletteChannelsSection:document.getElementById("palette-channels-section"),paletteAgentsSection:document.getElementById("palette-agents-section"),paletteMessagesSection:document.getElementById("palette-messages-section"),typingIndicator:document.getElementById("typing-indicator"),threadPanelOverlay:document.getElementById("thread-panel-overlay"),threadPanelId:document.getElementById("thread-panel-id"),threadPanelClose:document.getElementById("thread-panel-close"),threadMessages:document.getElementById("thread-messages"),threadMessageInput:document.getElementById("thread-message-input"),threadSendBtn:document.getElementById("thread-send-btn"),mentionAutocomplete:document.getElementById("mention-autocomplete"),mentionAutocompleteList:document.getElementById("mention-autocomplete-list"),spawnBtn:document.getElementById("spawn-btn"),spawnModalOverlay:document.getElementById("spawn-modal-overlay"),spawnModalClose:document.getElementById("spawn-modal-close"),spawnNameInput:document.getElementById("spawn-name-input"),spawnCliInput:document.getElementById("spawn-cli-input"),spawnTaskInput:document.getElementById("spawn-task-input"),spawnSubmitBtn:document.getElementById("spawn-submit-btn"),spawnStatus:document.getElementById("spawn-status")},a}function H(){return a}function ne(){i.isConnected?a.connectionDot.classList.remove("offline"):a.connectionDot.classList.add("offline")}function $(){console.log("[UI] renderAgents called, agents:",i.agents.length,i.agents.map(n=>n.name));let t=new Set(ee.map(n=>n.name)),e=i.agents.map(n=>{let o=L(n.lastSeen||n.lastActive)?"online":"",r=i.currentChannel===n.name,d=n.needsAttention?"needs-attention":"",p=t.has(n.name),S=p?`
        <svg class="spawned-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="Spawned from dashboard">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      `:"",ge=p?`
        <button class="release-btn" title="Release agent" data-release="${l(n.name)}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `:"";return`
      <li class="channel-item ${r?"active":""} ${d}" data-agent="${l(n.name)}" ${p?'title="Spawned from dashboard"':""}>
        <div class="agent-avatar" style="background: ${p?"var(--accent-green)":h(n.name)}">
          ${v(n.name)}
          <span class="presence-indicator ${o}"></span>
        </div>
        <span class="channel-name">${l(n.name)}</span>
        ${S}
        ${n.needsAttention?'<span class="attention-badge">Needs Input</span>':""}
        ${ge}
      </li>
    `}).join("");a.agentsList.innerHTML=e||'<li class="channel-item" style="color: var(--text-muted); cursor: default;">No agents connected</li>',a.agentsList.querySelectorAll(".channel-item[data-agent]").forEach(n=>{n.addEventListener("click",s=>{if(s.target.closest(".release-btn"))return;let o=n.dataset.agent;o&&g(o)})}),a.agentsList.querySelectorAll(".release-btn[data-release]").forEach(n=>{n.addEventListener("click",async s=>{s.stopPropagation();let o=n.dataset.release;o&&confirm(`Release agent "${o}"? This will terminate the agent.`)&&await Ee(o)})}),ve()}function D(){let t=J();if(t.length===0){a.messagesList.innerHTML=`
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="empty-state-title">No messages yet</div>
        <div class="empty-state-text">
          ${i.currentChannel==="general"?"Messages between agents will appear here":`Messages with ${i.currentChannel} will appear here`}
        </div>
      </div>
    `;return}let e="",n=null;t.forEach(s=>{let o=new Date(s.timestamp).toDateString();o!==n&&(e+=`
        <div class="date-divider">
          <span class="date-divider-text">${X(s.timestamp)}</span>
        </div>
      `,n=o);let r=s.to==="*",d=h(s.from),p=Y(s.id),S=r?"@everyone":s.project?`<span class="project-badge">${l(s.project)}</span>@${l(s.to)}`:`@${l(s.to)}`;e+=`
      <div class="message ${r?"broadcast":""}" data-id="${l(s.id)}">
        <div class="message-avatar" style="background: ${d}">
          ${v(s.from)}
        </div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-sender">@${l(s.from)}</span>
            <span class="message-recipient">
              \u2192 <span class="target">${S}</span>
            </span>
            <span class="message-timestamp">${C(s.timestamp)}</span>
          </div>
          <div class="message-body">${k(s.content)}</div>
          ${s.thread?`
            <div class="thread-indicator" data-thread="${l(s.thread)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Thread: ${l(s.thread)}
            </div>
          `:""}
          ${p>0?`
            <div class="reply-count-badge" data-thread="${l(s.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              ${p} ${p===1?"reply":"replies"}
            </div>
          `:""}
        </div>
        <div class="message-actions">
          <button class="message-action-btn" data-action="reply" title="Reply in thread">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="message-action-btn" title="Add reaction">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
              <line x1="9" y1="9" x2="9.01" y2="9"/>
              <line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>
        </div>
      </div>
    `}),a.messagesList.innerHTML=e,ye()}function g(t){z(t),a.channelsList.querySelectorAll(".channel-item").forEach(n=>{n.classList.toggle("active",n.dataset.channel===t)}),a.agentsList.querySelectorAll(".channel-item").forEach(n=>{n.classList.toggle("active",n.dataset.agent===t)});let e=document.querySelector(".channel-header-name .prefix");if(t==="general")a.currentChannelName.innerHTML="general",a.channelTopic.textContent="All agent communications",e&&(e.textContent="#");else{a.currentChannelName.innerHTML=l(t);let n=i.agents.find(s=>s.name===t);a.channelTopic.textContent=n?.status||"Direct messages",e&&(e.textContent="@")}a.messageInput.placeholder=t==="general"?"@AgentName message... (or @* to broadcast)":`Message ${t}... (@ not required)`,D()}function se(){let t=i.agents.filter(e=>L(e.lastSeen||e.lastActive)).length;a.onlineCount.textContent=`${t} online`}function ve(){let t=i.agents.map(s=>{let o=L(s.lastSeen||s.lastActive);return`
      <div class="palette-item" data-jump-agent="${l(s.name)}">
        <div class="palette-item-icon">
          <div class="agent-avatar" style="background: ${h(s.name)}; width: 20px; height: 20px; font-size: 9px;">
            ${v(s.name)}
            <span class="presence-indicator ${o?"online":""}"></span>
          </div>
        </div>
        <div class="palette-item-content">
          <div class="palette-item-title">${l(s.name)}</div>
          <div class="palette-item-subtitle">${o?"Online":"Offline"}</div>
        </div>
      </div>
    `}).join(""),e=a.paletteAgentsSection;e.querySelectorAll(".palette-item").forEach(s=>s.remove()),e.insertAdjacentHTML("beforeend",t),e.querySelectorAll(".palette-item[data-jump-agent]").forEach(s=>{s.addEventListener("click",()=>{let o=s.dataset.jumpAgent;o&&(g(o),m())})})}function ae(){a.paletteChannelsSection.querySelectorAll(".palette-item[data-jump-channel]").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.jumpChannel;e&&(g(e),m())})})}function P(){a.commandPaletteOverlay.classList.add("visible"),a.paletteSearch.value="",a.paletteSearch.focus(),c=-1,j("")}function oe(){return Array.from(a.paletteResults.querySelectorAll(".palette-item")).filter(e=>e.style.display!=="none")}function Z(){let t=oe();if(t.forEach(e=>e.classList.remove("selected")),c>=0&&c<t.length){let e=t[c];e.classList.add("selected"),e.scrollIntoView({block:"nearest",behavior:"smooth"})}}function re(t){let e=oe();if(e.length!==0)switch(t.key){case"ArrowDown":t.preventDefault(),c=c<e.length-1?c+1:0,Z();break;case"ArrowUp":t.preventDefault(),c=c>0?c-1:e.length-1,Z();break;case"Enter":t.preventDefault(),c>=0&&c<e.length&&fe(e[c]);break}}function fe(t){let e=t.dataset.command;if(e){e==="broadcast"?(a.messageInput.value="@* ",a.messageInput.focus()):e==="clear"&&(a.messagesList.innerHTML=""),m();return}let n=t.dataset.jumpChannel;if(n){g(n),m();return}let s=t.dataset.jumpAgent;if(s){g(s),m();return}let o=t.dataset.jumpMessage;if(o){let r=a.messagesList.querySelector(`[data-id="${o}"]`);r&&(r.scrollIntoView({behavior:"smooth",block:"center"}),r.classList.add("highlighted"),setTimeout(()=>r.classList.remove("highlighted"),2e3)),m();return}}function m(){a.commandPaletteOverlay.classList.remove("visible")}function j(t){let e=t.toLowerCase();if(c=-1,document.querySelectorAll(".palette-item[data-command]").forEach(n=>{let o=n.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";n.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-channel]").forEach(n=>{let o=n.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";n.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-agent]").forEach(n=>{let s=n.dataset.jumpAgent?.toLowerCase()||"";n.style.display=s.includes(e)?"flex":"none"}),e.length>=2){let n=i.messages.filter(s=>s.content.toLowerCase().includes(e)).slice(0,5);if(n.length>0){a.paletteMessagesSection.style.display="block";let s=n.map(r=>`
        <div class="palette-item" data-jump-message="${l(r.id)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${l(r.from)}</div>
            <div class="palette-item-subtitle">${l(r.content.substring(0,60))}${r.content.length>60?"...":""}</div>
          </div>
        </div>
      `).join("");a.paletteMessagesSection.querySelectorAll(".palette-item").forEach(r=>r.remove()),a.paletteMessagesSection.insertAdjacentHTML("beforeend",s)}else a.paletteMessagesSection.style.display="none"}else a.paletteMessagesSection.style.display="none"}function B(t){A(t),a.threadPanelId.textContent=t,a.threadPanelOverlay.classList.add("visible"),a.threadMessageInput.value="",N(t),a.threadMessageInput.focus()}function O(){A(null),a.threadPanelOverlay.classList.remove("visible")}function N(t){let e=Q(t);if(e.length===0){a.threadMessages.innerHTML=`
      <div class="thread-empty">
        <p>No messages in this thread yet.</p>
        <p style="font-size: 12px; margin-top: 8px;">Start the conversation below!</p>
      </div>
    `;return}let n=e.map(s=>`
      <div class="thread-message">
        <div class="thread-message-header">
          <div class="thread-message-avatar" style="background: ${h(s.from)}">
            ${v(s.from)}
          </div>
          <span class="thread-message-sender">${l(s.from)}</span>
          <span class="thread-message-time">${C(s.timestamp)}</span>
        </div>
        <div class="thread-message-body">${k(s.content)}</div>
      </div>
    `).join("");a.threadMessages.innerHTML=n,a.threadMessages.scrollTop=a.threadMessages.scrollHeight}function ye(){a.messagesList.querySelectorAll(".thread-indicator").forEach(t=>{t.style.cursor="pointer",t.addEventListener("click",e=>{e.stopPropagation();let n=t.dataset.thread;n&&B(n)})}),a.messagesList.querySelectorAll(".reply-count-badge").forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let n=t.dataset.thread;n&&B(n)})}),a.messagesList.querySelectorAll('.message-action-btn[data-action="reply"]').forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let n=t.closest(".message")?.getAttribute("data-id");n&&B(n)})})}var u=0,M=[];function ie(t){let e=t.toLowerCase();M=i.agents.filter(s=>s.name.toLowerCase().includes(e)),u=0;let n="";("*".includes(e)||"everyone".includes(e)||"all".includes(e)||"broadcast".includes(e))&&(n+=`
      <div class="mention-autocomplete-item ${u===0&&M.length===0?"selected":""}" data-mention="*">
        <div class="agent-avatar" style="background: var(--accent-yellow);">*</div>
        <span class="mention-autocomplete-name">@everyone</span>
        <span class="mention-autocomplete-role">Broadcast to all</span>
      </div>
    `),M.forEach((s,o)=>{n+=`
      <div class="mention-autocomplete-item ${o===u?"selected":""}" data-mention="${l(s.name)}">
        <div class="agent-avatar" style="background: ${h(s.name)}">
          ${v(s.name)}
        </div>
        <span class="mention-autocomplete-name">@${l(s.name)}</span>
        <span class="mention-autocomplete-role">${l(s.role||"Agent")}</span>
      </div>
    `}),n===""&&(n='<div class="mention-autocomplete-item" style="color: var(--text-muted); cursor: default;">No matching agents</div>'),a.mentionAutocompleteList.innerHTML=n,a.mentionAutocomplete.classList.add("visible"),a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]").forEach(s=>{s.addEventListener("click",()=>{let o=s.dataset.mention;o&&R(o)})})}function f(){a.mentionAutocomplete.classList.remove("visible"),M=[],u=0}function le(){return a.mentionAutocomplete.classList.contains("visible")}function q(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]");e.length!==0&&(e[u]?.classList.remove("selected"),t==="down"?u=(u+1)%e.length:u=(u-1+e.length)%e.length,e[u]?.classList.add("selected"),e[u]?.scrollIntoView({block:"nearest"}))}function R(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]"),n=t;if(!n&&e.length>0&&(n=e[u]?.dataset.mention),!n){f();return}let s=a.messageInput,o=s.value,r=o.match(/^@\S*/);if(r){let d=`@${n} `;s.value=d+o.substring(r[0].length),s.selectionStart=s.selectionEnd=d.length}f(),s.focus()}function ce(){let t=a.messageInput,e=t.value,n=t.selectionStart,s=e.match(/^@(\S*)/);return s&&n<=s[0].length?s[1]:null}function de(){a.spawnModalOverlay.classList.add("visible"),a.spawnNameInput.value="",a.spawnCliInput.value="claude",a.spawnTaskInput.value="",a.spawnStatus.textContent="",a.spawnStatus.className="spawn-status",a.spawnNameInput.focus()}function y(){a.spawnModalOverlay.classList.remove("visible")}async function K(){let t=a.spawnNameInput.value.trim(),e=a.spawnCliInput.value.trim()||"claude",n=a.spawnTaskInput.value.trim();if(!t)return a.spawnStatus.textContent="Agent name is required",a.spawnStatus.className="spawn-status error",{success:!1,error:"Agent name is required"};a.spawnSubmitBtn.disabled=!0,a.spawnStatus.textContent="Spawning agent...",a.spawnStatus.className="spawn-status loading";try{let s=await fetch("/api/spawn",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:t,cli:e,task:n})}),o=await s.json();if(s.ok&&o.success)return a.spawnStatus.textContent=`Agent "${t}" spawned successfully!`,a.spawnStatus.className="spawn-status success",await b(),setTimeout(()=>{y()},1e3),{success:!0};throw new Error(o.error||"Failed to spawn agent")}catch(s){return a.spawnStatus.textContent=s.message||"Failed to spawn agent",a.spawnStatus.className="spawn-status error",{success:!1,error:s.message}}finally{a.spawnSubmitBtn.disabled=!1}}async function b(){try{let e=await(await fetch("/api/spawned")).json();e.success&&Array.isArray(e.agents)&&(ee=e.agents,$())}catch(t){console.error("[UI] Failed to fetch spawned agents:",t)}}async function Ee(t){try{let n=await(await fetch(`/api/spawned/${encodeURIComponent(t)}`,{method:"DELETE"})).json();n.success?await b():console.error("[UI] Failed to release agent:",n.error)}catch(e){console.error("[UI] Failed to release agent:",e)}}function ue(){let t=te();V(()=>{ne(),$(),D(),se()}),we(t),I(),b()}function we(t){t.channelsList.querySelectorAll(".channel-item").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.channel;n&&g(n)})}),t.sendBtn.addEventListener("click",me),t.messageInput.addEventListener("keydown",e=>{if(le()){if(e.key==="Tab"||e.key==="Enter"){e.preventDefault(),R();return}if(e.key==="ArrowUp"){e.preventDefault(),q("up");return}if(e.key==="ArrowDown"){e.preventDefault(),q("down");return}if(e.key==="Escape"){e.preventDefault(),f();return}}e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),me())}),t.messageInput.addEventListener("input",()=>{t.messageInput.style.height="auto",t.messageInput.style.height=Math.min(t.messageInput.scrollHeight,200)+"px";let e=ce();e!==null?ie(e):f()}),t.messageInput.addEventListener("blur",()=>{setTimeout(()=>{f()},150)}),t.boldBtn.addEventListener("click",()=>{let e=t.messageInput,n=e.selectionStart,s=e.selectionEnd,o=e.value;if(n===s){let r=o.substring(0,n),d=o.substring(s);e.value=r+"**bold**"+d,e.selectionStart=n+2,e.selectionEnd=n+6}else{let r=o.substring(0,n),d=o.substring(n,s),p=o.substring(s);e.value=r+"**"+d+"**"+p,e.selectionStart=n,e.selectionEnd=s+4}e.focus()}),t.emojiBtn.addEventListener("click",()=>{let e=["\u{1F44D}","\u{1F44E}","\u2705","\u274C","\u{1F389}","\u{1F525}","\u{1F4A1}","\u26A0\uFE0F","\u{1F4DD}","\u{1F680}"],n=e[Math.floor(Math.random()*e.length)],s=t.messageInput,o=s.selectionStart,r=s.value;s.value=r.substring(0,o)+n+r.substring(o),s.selectionStart=s.selectionEnd=o+n.length,s.focus()}),t.searchTrigger.addEventListener("click",P),document.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="k"&&(e.preventDefault(),t.commandPaletteOverlay.classList.contains("visible")?m():P()),e.key==="Escape"&&m()}),t.commandPaletteOverlay.addEventListener("click",e=>{e.target===t.commandPaletteOverlay&&m()}),t.paletteSearch.addEventListener("input",e=>{let n=e.target;j(n.value)}),t.paletteSearch.addEventListener("keydown",re),document.querySelectorAll(".palette-item[data-command]").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.command;n==="broadcast"?(t.messageInput.value="@* ",t.messageInput.focus()):n==="clear"&&(t.messagesList.innerHTML=""),m()})}),ae(),t.threadPanelClose.addEventListener("click",O),t.threadSendBtn.addEventListener("click",pe),t.threadMessageInput.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),pe())}),document.addEventListener("keydown",e=>{e.key==="Escape"&&t.threadPanelOverlay.classList.contains("visible")&&O()}),t.spawnBtn.addEventListener("click",de),t.spawnModalClose.addEventListener("click",y),document.getElementById("spawn-cancel-btn")?.addEventListener("click",y),t.spawnModalOverlay.addEventListener("click",e=>{e.target===t.spawnModalOverlay&&y()}),document.addEventListener("keydown",e=>{e.key==="Escape"&&t.spawnModalOverlay.classList.contains("visible")&&y()}),t.spawnSubmitBtn.addEventListener("click",K),t.spawnNameInput.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),K())})}function Le(t){let n=t.trim().match(/^@(\*|[^\s]+)\s+(.+)$/s);return n?{to:n[1],message:n[2].trim()}:null}async function me(){let t=H(),e=t.messageInput.value.trim();if(!e)return;let n,s,o=i.currentChannel!=="general",r=Le(e);if(r)n=r.to,s=r.message;else if(o)n=i.currentChannel,s=e;else{alert('Message must start with @recipient (e.g., "@Lead hello" or "@* broadcast")');return}t.sendBtn.disabled=!0;let d=await T(n,s);d.success?(t.messageInput.value="",t.messageInput.style.height="auto"):alert(d.error),t.sendBtn.disabled=!1}async function pe(){let t=H(),e=t.threadMessageInput.value.trim(),n=i.currentThread;if(!e||!n)return;t.threadSendBtn.disabled=!0;let s=await T("*",e,n);s.success?(t.threadMessageInput.value="",N(n)):alert(s.error),t.threadSendBtn.disabled=!1}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",ue):ue());export{ue as initApp};
//# sourceMappingURL=app.js.map
