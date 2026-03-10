const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const waitingQueue = [];
const users = new Map();
const rooms = new Map();

function normalizeGender(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === "male" || value === "female" || value === "other") {
    return value;
  }
  return "other";
}

function normalizeName(input) {
  return String(input || "Anonymous").trim().slice(0, 30) || "Anonymous";
}

function removeFromWaitingQueue(socketId) {
  let index = waitingQueue.indexOf(socketId);
  while (index !== -1) {
    waitingQueue.splice(index, 1);
    index = waitingQueue.indexOf(socketId);
  }
}

function getUser(socketId) {
  return users.get(socketId) || null;
}

function getSocket(socketId) {
  return io.sockets.sockets.get(socketId) || null;
}

function makeRoomId(a, b) {
  return `room_${a}_${b}_${Date.now()}`;
}

function isSocketAvailableForMatch(socketId) {
  const user = getUser(socketId);
  return Boolean(user && !user.roomId);
}

function emitWaiting(socketId, message = "Looking for a stranger...") {
  io.to(socketId).emit("waiting", { message });
}

function joinAsStrangers(socketA, socketB) {
  const userA = getUser(socketA.id);
  const userB = getUser(socketB.id);

  if (!userA || !userB) {
    return false;
  }

  if (userA.roomId || userB.roomId) {
    return false;
  }

  removeFromWaitingQueue(socketA.id);
  removeFromWaitingQueue(socketB.id);

  const roomId = makeRoomId(socketA.id, socketB.id);
  const aStartsOffer = socketA.id < socketB.id;

  userA.roomId = roomId;
  userA.partnerId = socketB.id;

  userB.roomId = roomId;
  userB.partnerId = socketA.id;

  rooms.set(roomId, { a: socketA.id, b: socketB.id });

  socketA.join(roomId);
  socketB.join(roomId);

  io.to(socketA.id).emit("matched", {
    roomId,
    strangerGender: userB.gender,
    strangerName: userB.name,
    shouldInitiateOffer: aStartsOffer
  });

  io.to(socketB.id).emit("matched", {
    roomId,
    strangerGender: userA.gender,
    strangerName: userA.name,
    shouldInitiateOffer: !aStartsOffer
  });

  return true;
}

function tryMatch(socket) {
  const user = getUser(socket.id);
  if (!user || user.roomId) {
    return;
  }

  removeFromWaitingQueue(socket.id);

  let partnerId = null;

  for (const candidateId of waitingQueue) {
    if (candidateId === socket.id) {
      continue;
    }

    if (!isSocketAvailableForMatch(candidateId)) {
      continue;
    }

    partnerId = candidateId;
    break;
  }

  if (!partnerId) {
    waitingQueue.push(socket.id);
    emitWaiting(socket.id);
    return;
  }

  removeFromWaitingQueue(partnerId);

  const partnerSocket = getSocket(partnerId);
  if (!partnerSocket) {
    tryMatch(socket);
    return;
  }

  const matched = joinAsStrangers(socket, partnerSocket);
  if (!matched) {
    tryMatch(socket);
  }
}

function leaveRoom(socketId) {
  const user = getUser(socketId);
  if (!user || !user.roomId) {
    return;
  }

  const roomId = user.roomId;
  rooms.delete(roomId);

  user.roomId = null;
  user.partnerId = null;

  const socket = getSocket(socketId);
  if (socket) {
    socket.leave(roomId);
  }
}

function detachAndNotify(socketId, reason = "Stranger disconnected") {
  const user = getUser(socketId);
  if (!user) {
    return;
  }

  removeFromWaitingQueue(socketId);

  const partnerId = user.partnerId;
  const roomId = user.roomId;

  leaveRoom(socketId);

  if (!partnerId) {
    return;
  }

  const partner = getUser(partnerId);
  if (partner && partner.roomId === roomId) {
    leaveRoom(partnerId);
    io.to(partnerId).emit("partner-left", { reason });
    emitWaiting(partnerId, "Looking for a new stranger...");
  }
}

io.on("connection", (socket) => {
  socket.on("start-chat", ({ name, gender } = {}) => {
    const existingUser = getUser(socket.id);
    if (existingUser) {
      detachAndNotify(socket.id, "Stranger left the chat");
    }

    users.set(socket.id, {
      name: normalizeName(name),
      gender: normalizeGender(gender),
      roomId: null,
      partnerId: null
    });

    tryMatch(socket);
  });

  socket.on("next", () => {
    const user = getUser(socket.id);
    if (!user) {
      return;
    }

    detachAndNotify(socket.id, "Stranger skipped to next chat");
    tryMatch(socket);
  });

  socket.on("end-chat", () => {
    detachAndNotify(socket.id, "Stranger ended the chat");
    removeFromWaitingQueue(socket.id);
    users.delete(socket.id);
    io.to(socket.id).emit("chat-ended", { message: "You ended the chat." });
  });

  socket.on("report-user", (payload = {}) => {
    const reporter = getUser(socket.id);
    if (!reporter || !reporter.partnerId) {
      return;
    }

    const reported = getUser(reporter.partnerId);
    console.log("[REPORT]", {
      at: new Date().toISOString(),
      reporterId: socket.id,
      reporterName: reporter.name,
      reporterGender: reporter.gender,
      reportedId: reporter.partnerId,
      reportedName: reported?.name || "Unknown",
      reportedGender: reported?.gender || "Unknown",
      reason: String(payload.reason || "No reason provided").slice(0, 250)
    });
  });

  socket.on("chat-message", ({ message } = {}) => {
    const user = getUser(socket.id);
    if (!user || !user.partnerId || !user.roomId) {
      return;
    }

    const cleanMessage = String(message || "").trim().slice(0, 500);
    if (!cleanMessage) {
      return;
    }

    io.to(user.roomId).emit("chat-message", {
      from: socket.id,
      name: user.name,
      message: cleanMessage
    });
  });

  socket.on("typing", () => {
    const user = getUser(socket.id);
    if (!user || !user.partnerId || !user.roomId) {
      return;
    }

    socket.to(user.roomId).emit("typing", {
      name: user.name
    });
  });

  socket.on("webrtc-offer", ({ sdp } = {}) => {
    const user = getUser(socket.id);
    if (!user || !user.partnerId || !sdp) {
      return;
    }

    io.to(user.partnerId).emit("webrtc-offer", { sdp });
  });

  socket.on("webrtc-answer", ({ sdp } = {}) => {
    const user = getUser(socket.id);
    if (!user || !user.partnerId || !sdp) {
      return;
    }

    io.to(user.partnerId).emit("webrtc-answer", { sdp });
  });

  socket.on("webrtc-ice-candidate", ({ candidate } = {}) => {
    const user = getUser(socket.id);
    if (!user || !user.partnerId || !candidate) {
      return;
    }

    io.to(user.partnerId).emit("webrtc-ice-candidate", { candidate });
  });

  socket.on("disconnect", () => {
    detachAndNotify(socket.id, "Stranger disconnected");
    removeFromWaitingQueue(socket.id);
    users.delete(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
