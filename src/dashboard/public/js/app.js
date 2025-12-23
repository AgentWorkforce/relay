var r={agents:[],messages:[],currentChannel:"general",currentThread:null,isConnected:!1,ws:null,reconnectAttempts:0},f=[];function q(t){return f.push(t),()=>{let e=f.indexOf(t);e>-1&&f.splice(e,1)}}function y(){f.forEach(t=>t())}function N(t){r.agents=t,y()}function K(t){r.messages=t,y()}function R(t){r.currentChannel=t,y()}function x(t){r.isConnected=t,t&&(r.reconnectAttempts=0),y()}function V(){r.reconnectAttempts++}function z(t){r.ws=t}function W(){let{messages:t,currentChannel:e}=r;return e==="general"?t:t.filter(n=>n.from===e||n.to===e)}function S(t){r.currentThread=t}function F(t){return r.messages.filter(e=>e.thread===t)}function U(t){return r.messages.filter(e=>e.thread===t).length}var _=null;function A(){let t=window.location.protocol==="https:"?"wss:":"ws:",e=new WebSocket(`${t}//${window.location.host}/ws`);e.onopen=()=>{x(!0)},e.onclose=()=>{x(!1);let n=Math.min(1e3*Math.pow(2,r.reconnectAttempts),3e4);V(),setTimeout(A,n)},e.onerror=n=>{console.error("WebSocket error:",n)},e.onmessage=n=>{try{let s=JSON.parse(n.data);de(s)}catch(s){console.error("Failed to parse message:",s)}},z(e)}function de(t){console.log("[WS] Received data:",{agentCount:t.agents?.length,messageCount:t.messages?.length}),t.agents&&(console.log("[WS] Setting agents:",t.agents.map(e=>e.name)),N(t.agents)),t.messages&&K(t.messages),_&&_(t)}async function T(t,e,n){try{let s={to:t,message:e};n&&(s.thread=n);let o=await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(s)}),i=await o.json();return o.ok&&i.success?{success:!0}:{success:!1,error:i.error||"Failed to send message"}}catch{return{success:!1,error:"Network error - could not send message"}}}function E(t){if(!t)return!1;let e=Date.parse(t);return Number.isNaN(e)?!1:Date.now()-e<3e4}function l(t){if(!t)return"";let e=document.createElement("div");return e.textContent=t,e.innerHTML}function C(t){return new Date(t).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}function J(t){let e=new Date(t),n=new Date,s=new Date(n);return s.setDate(s.getDate()-1),e.toDateString()===n.toDateString()?"Today":e.toDateString()===s.toDateString()?"Yesterday":e.toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})}function g(t){let e=["#e01e5a","#2bac76","#e8a427","#1264a3","#7c3aed","#0d9488","#dc2626","#9333ea","#ea580c","#0891b2"],n=0;for(let s=0;s<t.length;s++)n=t.charCodeAt(s)+((n<<5)-n);return e[Math.abs(n)%e.length]}function h(t){return t.substring(0,2).toUpperCase()}function w(t){if(!t)return"";let e=l(t);return e=e.replace(/```([\s\S]*?)```/g,"<pre>$1</pre>"),e=e.replace(/`([^`]+)`/g,"<code>$1</code>"),e=e.replace(/\n/g,"<br>"),e}var a,c=-1;function Y(){return a={connectionDot:document.getElementById("connection-dot"),channelsList:document.getElementById("channels-list"),agentsList:document.getElementById("agents-list"),messagesList:document.getElementById("messages-list"),currentChannelName:document.getElementById("current-channel-name"),channelTopic:document.getElementById("channel-topic"),onlineCount:document.getElementById("online-count"),messageInput:document.getElementById("message-input"),sendBtn:document.getElementById("send-btn"),boldBtn:document.getElementById("bold-btn"),emojiBtn:document.getElementById("emoji-btn"),searchTrigger:document.getElementById("search-trigger"),commandPaletteOverlay:document.getElementById("command-palette-overlay"),paletteSearch:document.getElementById("palette-search"),paletteResults:document.getElementById("palette-results"),paletteChannelsSection:document.getElementById("palette-channels-section"),paletteAgentsSection:document.getElementById("palette-agents-section"),paletteMessagesSection:document.getElementById("palette-messages-section"),typingIndicator:document.getElementById("typing-indicator"),threadPanelOverlay:document.getElementById("thread-panel-overlay"),threadPanelId:document.getElementById("thread-panel-id"),threadPanelClose:document.getElementById("thread-panel-close"),threadMessages:document.getElementById("thread-messages"),threadMessageInput:document.getElementById("thread-message-input"),threadSendBtn:document.getElementById("thread-send-btn"),mentionAutocomplete:document.getElementById("mention-autocomplete"),mentionAutocompleteList:document.getElementById("mention-autocomplete-list")},a}function k(){return a}function G(){r.isConnected?a.connectionDot.classList.remove("offline"):a.connectionDot.classList.add("offline")}function X(){console.log("[UI] renderAgents called, agents:",r.agents.length,r.agents.map(e=>e.name));let t=r.agents.map(e=>{let s=E(e.lastSeen||e.lastActive)?"online":"",o=r.currentChannel===e.name,i=e.needsAttention?"needs-attention":"";return`
      <li class="channel-item ${o?"active":""} ${i}" data-agent="${l(e.name)}">
        <div class="agent-avatar" style="background: ${g(e.name)}">
          ${h(e.name)}
          <span class="presence-indicator ${s}"></span>
        </div>
        <span class="channel-name">${l(e.name)}</span>
        ${e.needsAttention?'<span class="attention-badge">Needs Input</span>':""}
      </li>
    `}).join("");a.agentsList.innerHTML=t||'<li class="channel-item" style="color: var(--text-muted); cursor: default;">No agents connected</li>',a.agentsList.querySelectorAll(".channel-item[data-agent]").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.agent;n&&p(n)})}),me()}function H(){let t=W();if(t.length===0){a.messagesList.innerHTML=`
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <div class="empty-state-title">No messages yet</div>
        <div class="empty-state-text">
          ${r.currentChannel==="general"?"Messages between agents will appear here":`Messages with ${r.currentChannel} will appear here`}
        </div>
      </div>
    `;return}let e="",n=null;t.forEach(o=>{let i=new Date(o.timestamp).toDateString();i!==n&&(e+=`
        <div class="date-divider">
          <span class="date-divider-text">${J(o.timestamp)}</span>
        </div>
      `,n=i);let u=o.to==="*",M=g(o.from),b=U(o.id),ce=u?"@everyone":`@${l(o.to)}`;e+=`
      <div class="message ${u?"broadcast":""}" data-id="${l(o.id)}">
        <div class="message-avatar" style="background: ${M}">
          ${h(o.from)}
        </div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-sender">@${l(o.from)}</span>
            <span class="message-recipient">
              \u2192 <span class="target">${ce}</span>
            </span>
            <span class="message-timestamp">${C(o.timestamp)}</span>
          </div>
          <div class="message-body">${w(o.content)}</div>
          ${o.thread?`
            <div class="thread-indicator" data-thread="${l(o.thread)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Thread: ${l(o.thread)}
            </div>
          `:""}
          ${b>0?`
            <div class="reply-count-badge" data-thread="${l(o.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              ${b} ${b===1?"reply":"replies"}
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
    `}),a.messagesList.innerHTML=e;let s=a.messagesList.parentElement;s&&(s.scrollTop=s.scrollHeight),pe()}function p(t){R(t),a.channelsList.querySelectorAll(".channel-item").forEach(n=>{n.classList.toggle("active",n.dataset.channel===t)}),a.agentsList.querySelectorAll(".channel-item").forEach(n=>{n.classList.toggle("active",n.dataset.agent===t)});let e=document.querySelector(".channel-header-name .prefix");if(t==="general")a.currentChannelName.innerHTML="general",a.channelTopic.textContent="All agent communications",e&&(e.textContent="#");else{a.currentChannelName.innerHTML=l(t);let n=r.agents.find(s=>s.name===t);a.channelTopic.textContent=n?.status||"Direct messages",e&&(e.textContent="@")}a.messageInput.placeholder=t==="general"?"@AgentName message... (or @* to broadcast)":`@${t} your message here...`,H()}function Z(){let t=r.agents.filter(e=>E(e.lastSeen||e.lastActive)).length;a.onlineCount.textContent=`${t} online`}function me(){let t=r.agents.map(s=>{let o=E(s.lastSeen||s.lastActive);return`
      <div class="palette-item" data-jump-agent="${l(s.name)}">
        <div class="palette-item-icon">
          <div class="agent-avatar" style="background: ${g(s.name)}; width: 20px; height: 20px; font-size: 9px;">
            ${h(s.name)}
            <span class="presence-indicator ${o?"online":""}"></span>
          </div>
        </div>
        <div class="palette-item-content">
          <div class="palette-item-title">${l(s.name)}</div>
          <div class="palette-item-subtitle">${o?"Online":"Offline"}</div>
        </div>
      </div>
    `}).join(""),e=a.paletteAgentsSection;e.querySelectorAll(".palette-item").forEach(s=>s.remove()),e.insertAdjacentHTML("beforeend",t),e.querySelectorAll(".palette-item[data-jump-agent]").forEach(s=>{s.addEventListener("click",()=>{let o=s.dataset.jumpAgent;o&&(p(o),m())})})}function ee(){a.paletteChannelsSection.querySelectorAll(".palette-item[data-jump-channel]").forEach(t=>{t.addEventListener("click",()=>{let e=t.dataset.jumpChannel;e&&(p(e),m())})})}function $(){a.commandPaletteOverlay.classList.add("visible"),a.paletteSearch.value="",a.paletteSearch.focus(),c=-1,D("")}function te(){return Array.from(a.paletteResults.querySelectorAll(".palette-item")).filter(e=>e.style.display!=="none")}function Q(){let t=te();if(t.forEach(e=>e.classList.remove("selected")),c>=0&&c<t.length){let e=t[c];e.classList.add("selected"),e.scrollIntoView({block:"nearest",behavior:"smooth"})}}function ne(t){let e=te();if(e.length!==0)switch(t.key){case"ArrowDown":t.preventDefault(),c=c<e.length-1?c+1:0,Q();break;case"ArrowUp":t.preventDefault(),c=c>0?c-1:e.length-1,Q();break;case"Enter":t.preventDefault(),c>=0&&c<e.length&&ue(e[c]);break}}function ue(t){let e=t.dataset.command;if(e){e==="broadcast"?(a.messageInput.value="@* ",a.messageInput.focus()):e==="clear"&&(a.messagesList.innerHTML=""),m();return}let n=t.dataset.jumpChannel;if(n){p(n),m();return}let s=t.dataset.jumpAgent;if(s){p(s),m();return}let o=t.dataset.jumpMessage;if(o){let i=a.messagesList.querySelector(`[data-id="${o}"]`);i&&(i.scrollIntoView({behavior:"smooth",block:"center"}),i.classList.add("highlighted"),setTimeout(()=>i.classList.remove("highlighted"),2e3)),m();return}}function m(){a.commandPaletteOverlay.classList.remove("visible")}function D(t){let e=t.toLowerCase();if(c=-1,document.querySelectorAll(".palette-item[data-command]").forEach(n=>{let o=n.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";n.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-channel]").forEach(n=>{let o=n.querySelector(".palette-item-title")?.textContent?.toLowerCase()||"";n.style.display=o.includes(e)?"flex":"none"}),document.querySelectorAll(".palette-item[data-jump-agent]").forEach(n=>{let s=n.dataset.jumpAgent?.toLowerCase()||"";n.style.display=s.includes(e)?"flex":"none"}),e.length>=2){let n=r.messages.filter(s=>s.content.toLowerCase().includes(e)).slice(0,5);if(n.length>0){a.paletteMessagesSection.style.display="block";let s=n.map(i=>`
        <div class="palette-item" data-jump-message="${l(i.id)}">
          <div class="palette-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="palette-item-content">
            <div class="palette-item-title">${l(i.from)}</div>
            <div class="palette-item-subtitle">${l(i.content.substring(0,60))}${i.content.length>60?"...":""}</div>
          </div>
        </div>
      `).join("");a.paletteMessagesSection.querySelectorAll(".palette-item").forEach(i=>i.remove()),a.paletteMessagesSection.insertAdjacentHTML("beforeend",s)}else a.paletteMessagesSection.style.display="none"}else a.paletteMessagesSection.style.display="none"}function I(t){S(t),a.threadPanelId.textContent=t,a.threadPanelOverlay.classList.add("visible"),a.threadMessageInput.value="",P(t),a.threadMessageInput.focus()}function B(){S(null),a.threadPanelOverlay.classList.remove("visible")}function P(t){let e=F(t);if(e.length===0){a.threadMessages.innerHTML=`
      <div class="thread-empty">
        <p>No messages in this thread yet.</p>
        <p style="font-size: 12px; margin-top: 8px;">Start the conversation below!</p>
      </div>
    `;return}let n=e.map(s=>`
      <div class="thread-message">
        <div class="thread-message-header">
          <div class="thread-message-avatar" style="background: ${g(s.from)}">
            ${h(s.from)}
          </div>
          <span class="thread-message-sender">${l(s.from)}</span>
          <span class="thread-message-time">${C(s.timestamp)}</span>
        </div>
        <div class="thread-message-body">${w(s.content)}</div>
      </div>
    `).join("");a.threadMessages.innerHTML=n,a.threadMessages.scrollTop=a.threadMessages.scrollHeight}function pe(){a.messagesList.querySelectorAll(".thread-indicator").forEach(t=>{t.style.cursor="pointer",t.addEventListener("click",e=>{e.stopPropagation();let n=t.dataset.thread;n&&I(n)})}),a.messagesList.querySelectorAll(".reply-count-badge").forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let n=t.dataset.thread;n&&I(n)})}),a.messagesList.querySelectorAll('.message-action-btn[data-action="reply"]').forEach(t=>{t.addEventListener("click",e=>{e.stopPropagation();let n=t.closest(".message")?.getAttribute("data-id");n&&I(n)})})}var d=0,L=[];function se(t){let e=t.toLowerCase();L=r.agents.filter(s=>s.name.toLowerCase().includes(e)),d=0;let n="";("*".includes(e)||"everyone".includes(e)||"all".includes(e)||"broadcast".includes(e))&&(n+=`
      <div class="mention-autocomplete-item ${d===0&&L.length===0?"selected":""}" data-mention="*">
        <div class="agent-avatar" style="background: var(--accent-yellow);">*</div>
        <span class="mention-autocomplete-name">@everyone</span>
        <span class="mention-autocomplete-role">Broadcast to all</span>
      </div>
    `),L.forEach((s,o)=>{n+=`
      <div class="mention-autocomplete-item ${o===d?"selected":""}" data-mention="${l(s.name)}">
        <div class="agent-avatar" style="background: ${g(s.name)}">
          ${h(s.name)}
        </div>
        <span class="mention-autocomplete-name">@${l(s.name)}</span>
        <span class="mention-autocomplete-role">${l(s.role||"Agent")}</span>
      </div>
    `}),n===""&&(n='<div class="mention-autocomplete-item" style="color: var(--text-muted); cursor: default;">No matching agents</div>'),a.mentionAutocompleteList.innerHTML=n,a.mentionAutocomplete.classList.add("visible"),a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]").forEach(s=>{s.addEventListener("click",()=>{let o=s.dataset.mention;o&&O(o)})})}function v(){a.mentionAutocomplete.classList.remove("visible"),L=[],d=0}function ae(){return a.mentionAutocomplete.classList.contains("visible")}function j(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]");e.length!==0&&(e[d]?.classList.remove("selected"),t==="down"?d=(d+1)%e.length:d=(d-1+e.length)%e.length,e[d]?.classList.add("selected"),e[d]?.scrollIntoView({block:"nearest"}))}function O(t){let e=a.mentionAutocompleteList.querySelectorAll(".mention-autocomplete-item[data-mention]"),n=t;if(!n&&e.length>0&&(n=e[d]?.dataset.mention),!n){v();return}let s=a.messageInput,o=s.value,i=o.match(/^@\S*/);if(i){let u=`@${n} `;s.value=u+o.substring(i[0].length),s.selectionStart=s.selectionEnd=u.length}v(),s.focus()}function oe(){let t=a.messageInput,e=t.value,n=t.selectionStart,s=e.match(/^@(\S*)/);return s&&n<=s[0].length?s[1]:null}function ie(){let t=Y();q(()=>{G(),X(),H(),Z()}),ge(t),A()}function ge(t){t.channelsList.querySelectorAll(".channel-item").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.channel;n&&p(n)})}),t.sendBtn.addEventListener("click",re),t.messageInput.addEventListener("keydown",e=>{if(ae()){if(e.key==="Tab"||e.key==="Enter"){e.preventDefault(),O();return}if(e.key==="ArrowUp"){e.preventDefault(),j("up");return}if(e.key==="ArrowDown"){e.preventDefault(),j("down");return}if(e.key==="Escape"){e.preventDefault(),v();return}}e.key==="Enter"&&(e.ctrlKey||e.metaKey)&&(e.preventDefault(),re())}),t.messageInput.addEventListener("input",()=>{t.messageInput.style.height="auto",t.messageInput.style.height=Math.min(t.messageInput.scrollHeight,200)+"px";let e=oe();e!==null?se(e):v()}),t.messageInput.addEventListener("blur",()=>{setTimeout(()=>{v()},150)}),t.boldBtn.addEventListener("click",()=>{let e=t.messageInput,n=e.selectionStart,s=e.selectionEnd,o=e.value;if(n===s){let i=o.substring(0,n),u=o.substring(s);e.value=i+"**bold**"+u,e.selectionStart=n+2,e.selectionEnd=n+6}else{let i=o.substring(0,n),u=o.substring(n,s),M=o.substring(s);e.value=i+"**"+u+"**"+M,e.selectionStart=n,e.selectionEnd=s+4}e.focus()}),t.emojiBtn.addEventListener("click",()=>{let e=["\u{1F44D}","\u{1F44E}","\u2705","\u274C","\u{1F389}","\u{1F525}","\u{1F4A1}","\u26A0\uFE0F","\u{1F4DD}","\u{1F680}"],n=e[Math.floor(Math.random()*e.length)],s=t.messageInput,o=s.selectionStart,i=s.value;s.value=i.substring(0,o)+n+i.substring(o),s.selectionStart=s.selectionEnd=o+n.length,s.focus()}),t.searchTrigger.addEventListener("click",$),document.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="k"&&(e.preventDefault(),t.commandPaletteOverlay.classList.contains("visible")?m():$()),e.key==="Escape"&&m()}),t.commandPaletteOverlay.addEventListener("click",e=>{e.target===t.commandPaletteOverlay&&m()}),t.paletteSearch.addEventListener("input",e=>{let n=e.target;D(n.value)}),t.paletteSearch.addEventListener("keydown",ne),document.querySelectorAll(".palette-item[data-command]").forEach(e=>{e.addEventListener("click",()=>{let n=e.dataset.command;n==="broadcast"?(t.messageInput.value="@* ",t.messageInput.focus()):n==="clear"&&(t.messagesList.innerHTML=""),m()})}),ee(),t.threadPanelClose.addEventListener("click",B),t.threadSendBtn.addEventListener("click",le),t.threadMessageInput.addEventListener("keydown",e=>{e.key==="Enter"&&(e.ctrlKey||e.metaKey)&&(e.preventDefault(),le())}),document.addEventListener("keydown",e=>{e.key==="Escape"&&t.threadPanelOverlay.classList.contains("visible")&&B()})}function he(t){let n=t.trim().match(/^@(\*|[^\s]+)\s+(.+)$/s);return n?{to:n[1],message:n[2].trim()}:null}async function re(){let t=k(),e=t.messageInput.value.trim();if(!e)return;let n=he(e);if(!n){alert('Message must start with @recipient (e.g., "@Lead hello" or "@* broadcast")');return}let{to:s,message:o}=n;t.sendBtn.disabled=!0;let i=await T(s,o);i.success?(t.messageInput.value="",t.messageInput.style.height="auto"):alert(i.error),t.sendBtn.disabled=!1}async function le(){let t=k(),e=t.threadMessageInput.value.trim(),n=r.currentThread;if(!e||!n)return;t.threadSendBtn.disabled=!0;let s=await T("*",e,n);s.success?(t.threadMessageInput.value="",P(n)):alert(s.error),t.threadSendBtn.disabled=!1}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",ie):ie());export{ie as initApp};
//# sourceMappingURL=app.js.map
