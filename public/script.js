const socket = io();

const joinScreen = document.getElementById("joinScreen");
const chatScreen = document.getElementById("chatScreen");
const nameInput = document.getElementById("nameInput");
const genderSelect = document.getElementById("genderSelect");
const startBtn = document.getElementById("startBtn");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteTag = document.getElementById("remoteTag");
const statusBadge = document.getElementById("statusBadge");
const strangerLabel = document.getElementById("strangerLabel");

const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const nextBtn = document.getElementById("nextBtn");
const endBtn = document.getElementById("endBtn");
const reportBtn = document.getElementById("reportBtn");

const messages = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const typingBox = document.getElementById("typing");

let localStream = null;
let peerConnection = null;
let isMuted = false;
let isCameraOff = false;
let isMatched = false;
let username = "";
let strangerName = "Stranger";
let typingTimeoutId = null;
let pendingIceCandidates = [];

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all"
};

function addSystemMessage(text) {
  const node = document.createElement("div");
  node.className = "message system";
  node.textContent = text;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
}

function addChatMessage(text, type) {
  const node = document.createElement("div");
  node.className = `message ${type}`;
  node.textContent = text;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
}

function setTypingText(text) {
  if (!typingBox) {
    return;
  }

  typingBox.textContent = text;
}

function clearTypingIndicator() {
  if (typingTimeoutId) {
    clearTimeout(typingTimeoutId);
    typingTimeoutId = null;
  }

  setTypingText("");
}

function showTypingIndicator(name) {
  clearTypingIndicator();
  setTypingText(`${name || "Stranger"} is typing...`);
  typingTimeoutId = setTimeout(() => {
    setTypingText("");
    typingTimeoutId = null;
  }, 1500);
}

function setChatEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  reportBtn.disabled = !enabled;
}

function resetRemoteState(statusText = "Waiting...") {
  strangerName = "Stranger";
  isMatched = false;
  statusBadge.textContent = statusText;
  strangerLabel.textContent = "Stranger";
  remoteTag.textContent = "Stranger";
  setChatEnabled(false);
  clearTypingIndicator();
}

async function setupLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  localVideo.srcObject = localStream;
}

async function flushPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) {
    return;
  }

  const queued = [...pendingIceCandidates];
  pendingIceCandidates = [];

  for (const candidate of queued) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error("Failed to add queued ICE candidate", error);
    }
  }
}

function buildPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
  }

  pendingIceCandidates = [];

  peerConnection = new RTCPeerConnection({
    ...rtcConfig,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  });

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      remoteVideo.srcObject = stream;
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    socket.emit("webrtc-ice-candidate", {
      candidate: event.candidate
    });
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;

    if (state === "connected") {
      statusBadge.textContent = "Connected";
    }

    if (state === "disconnected" || state === "failed" || state === "closed") {
      closePeerConnection();
      if (isMatched) {
        resetRemoteState("Disconnected");
        addSystemMessage("Connection lost. Waiting for the next stranger...");
      }
    }
  };
}

async function createOffer() {
  if (!localStream) {
    await setupLocalMedia();
  }

  buildPeerConnection();
  const offer = await peerConnection.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true
  });
  await peerConnection.setLocalDescription(offer);
  socket.emit("webrtc-offer", { sdp: peerConnection.localDescription });
}

async function handleOffer(sdp) {
  if (!localStream) {
    await setupLocalMedia();
  }

  buildPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPendingIceCandidates();

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("webrtc-answer", { sdp: peerConnection.localDescription });
}

async function handleAnswer(sdp) {
  if (!peerConnection) {
    return;
  }

  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPendingIceCandidates();
}

async function handleIceCandidate(candidate) {
  if (!candidate) {
    return;
  }

  if (!peerConnection || !peerConnection.remoteDescription) {
    pendingIceCandidates.push(candidate);
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error("Failed to add ICE candidate", error);
  }
}

function closePeerConnection() {
  pendingIceCandidates = [];

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  remoteVideo.srcObject = null;
}

async function startChatFlow() {
  const name = nameInput.value.trim() || "Anonymous";
  const gender = genderSelect.value;

  startBtn.disabled = true;

  try {
    if (!localStream) {
      await setupLocalMedia();
    }

    username = name;
    messages.innerHTML = "";
    messageInput.value = "";
    clearTypingIndicator();
    closePeerConnection();
    resetRemoteState("Searching...");
    addSystemMessage("Searching for a random stranger...");

    joinScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");

    socket.emit("start-chat", { name, gender });
  } catch (error) {
    console.error("Failed to start local media", error);
    alert("Camera and microphone access are required to start video chat.");
    startBtn.disabled = false;
  }
}

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !isMatched) {
    return;
  }

  socket.emit("chat-message", { message });
  addChatMessage(`You (${username}): ${message}`, "self");
  messageInput.value = "";
  clearTypingIndicator();
}

startBtn.addEventListener("click", startChatFlow);

muteBtn.addEventListener("click", () => {
  if (!localStream) {
    return;
  }

  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMuted;
  });
  muteBtn.textContent = isMuted ? "Unmute" : "Mute";
});

cameraBtn.addEventListener("click", () => {
  if (!localStream) {
    return;
  }

  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach((track) => {
    track.enabled = !isCameraOff;
  });
  cameraBtn.textContent = isCameraOff ? "Camera On" : "Camera Off";
});

nextBtn.addEventListener("click", () => {
  addSystemMessage("Moving to next stranger...");
  closePeerConnection();
  resetRemoteState("Finding next...");
  socket.emit("next");
});

endBtn.addEventListener("click", () => {
  socket.emit("end-chat");
  closePeerConnection();
  resetRemoteState("Chat ended");
  addSystemMessage("You ended the chat.");
  chatScreen.classList.add("hidden");
  joinScreen.classList.remove("hidden");
  startBtn.disabled = false;
});

reportBtn.addEventListener("click", () => {
  if (!isMatched) {
    return;
  }

  const reason =
    prompt("Reason for reporting this user:", "Abusive behavior") || "User reported";
  socket.emit("report-user", { reason });
  addSystemMessage("Report submitted.");
});

sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendMessage();
  }
});

messageInput.addEventListener("input", () => {
  if (!isMatched) {
    return;
  }

  socket.emit("typing");
});

socket.on("connect", () => {
  startBtn.disabled = false;
});

socket.on("disconnect", () => {
  closePeerConnection();
  resetRemoteState("Disconnected");
  addSystemMessage("Connection to server lost.");
  startBtn.disabled = false;
});

socket.on("waiting", ({ message } = {}) => {
  statusBadge.textContent = "Waiting...";
  strangerLabel.textContent = "Stranger";
  remoteTag.textContent = "Stranger";
  clearTypingIndicator();
  addSystemMessage(message || "Looking for stranger...");
});

socket.on("matched", async ({ strangerGender, strangerName: matchedName, shouldInitiateOffer } = {}) => {
  isMatched = true;
  strangerName = matchedName || "Stranger";
  setChatEnabled(true);
  clearTypingIndicator();

  const genderLabel = String(strangerGender || "other").replace(/^./, (char) =>
    char.toUpperCase()
  );
  const label = `${strangerName} (${genderLabel})`;

  statusBadge.textContent = "Connecting...";
  strangerLabel.textContent = label;
  remoteTag.textContent = label;
  addSystemMessage(`Connected with ${label}`);

  if (shouldInitiateOffer) {
    setTimeout(() => {
      if (!isMatched) {
        return;
      }

      createOffer().catch((error) => {
        console.error("Offer creation failed", error);
        addSystemMessage("Unable to start video connection.");
      });
    }, 300);
  }
});

socket.on("typing", ({ name } = {}) => {
  if (!isMatched) {
    return;
  }

  showTypingIndicator(name || strangerName);
});

socket.on("webrtc-offer", async ({ sdp } = {}) => {
  try {
    await handleOffer(sdp);
  } catch (error) {
    console.error("Offer handling failed", error);
    addSystemMessage("Incoming connection failed.");
  }
});

socket.on("webrtc-answer", async ({ sdp } = {}) => {
  try {
    await handleAnswer(sdp);
  } catch (error) {
    console.error("Answer handling failed", error);
    addSystemMessage("Remote answer could not be applied.");
  }
});

socket.on("webrtc-ice-candidate", async ({ candidate } = {}) => {
  await handleIceCandidate(candidate);
});

socket.on("chat-message", ({ from, name, message } = {}) => {
  if (!message) {
    return;
  }

  if (from === socket.id) {
    return;
  }

  addChatMessage(`${name || strangerName}: ${message}`, "other");
});

socket.on("partner-left", ({ reason } = {}) => {
  closePeerConnection();
  resetRemoteState("Disconnected");
  addSystemMessage(reason || "Stranger left the chat.");
});

socket.on("chat-ended", ({ message } = {}) => {
  addSystemMessage(message || "Chat ended.");
});
