import { Device } from "mediasoup-client";

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const startBtn = document.getElementById("startBtn");
const statusDiv = document.getElementById("status");

let ws;
let device;
let sendTransport;
let recvTransport;
const consumers = {};
let mode = 'both'; // 'both', 'send', 'receive'

remoteVideo.addEventListener('loadedmetadata', () => {
  console.log('Remote video metadata loaded');
  console.log('Video dimensions:', remoteVideo.videoWidth, 'x', remoteVideo.videoHeight);
});

remoteVideo.addEventListener('canplay', () => {
  console.log('Remote video can play');
});

remoteVideo.addEventListener('playing', () => {
  console.log('Remote video is playing');
});

remoteVideo.addEventListener('error', (e) => {
  console.error('Remote video error:', e);
});

localVideo.addEventListener('loadedmetadata', () => {
  console.log('Local video metadata loaded');
  console.log('Video dimensions:', localVideo.videoWidth, 'x', localVideo.videoHeight);
});

function updateStatus(msg) {
  statusDiv.textContent = "Status: " + msg;
  console.log(msg);
}

startBtn.onclick = async () => {
  try {
    // Get selected mode
    mode = document.querySelector('input[name="mode"]:checked').value;
    console.log("Starting in mode:", mode);
    
    startBtn.disabled = true;
    ws = new WebSocket("ws://localhost:3000");
    
    ws.onopen = () => {
      updateStatus("WebSocket connected");
    };

    ws.onerror = (error) => {
      updateStatus("WebSocket error");
      console.error("WebSocket error:", error);
      startBtn.disabled = false;
    };

    ws.onclose = () => {
      updateStatus("WebSocket disconnected");
      startBtn.disabled = false;
    };

    ws.onmessage = async (msg) => {
      const { type, data } = JSON.parse(msg.data);

      try {
        if (type === "rtpCapabilities") {
          updateStatus("Loading device...");
          device = new Device();
          await device.load({ routerRtpCapabilities: data });
          updateStatus("Device loaded, mode: " + mode);
          console.log("Mode selected:", mode);

          if (mode === 'send' || mode === 'both') {
            console.log("Creating send transport");
            ws.send(JSON.stringify({ type: "createWebRtcTransport", data: { purpose: "send" } }));
          } else if (mode === 'receive') {
            console.log("Creating receive transport");
            ws.send(JSON.stringify({ type: "createWebRtcTransport", data: { purpose: "recv" } }));
          }
        }

        if (type === "createWebRtcTransport") {
          if (mode === 'receive' && !recvTransport) {
            recvTransport = device.createRecvTransport({
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
              iceServers: []
            });

            recvTransport.on("connect", ({ dtlsParameters }, callback, errCallback) => {
              ws.send(JSON.stringify({ 
                type: "connectTransport", 
                data: { transportId: recvTransport.id, dtlsParameters } 
              }));
              callback();
            });
            
            recvTransport.on("connectionstatechange", (state) => {
              console.log("Recv transport connection state:", state);
              if (state === "failed") {
                console.error("Recv transport connection failed!");
              }
            });

            updateStatus("Ready to receive");
            
            if (window.pendingConsumes && window.pendingConsumes.length > 0) {
              console.log("Processing pending consumes:", window.pendingConsumes);
              for (const producerId of window.pendingConsumes) {
                ws.send(JSON.stringify({ 
                  type: "consume", 
                  data: { 
                    producerId: producerId, 
                    rtpCapabilities: device.rtpCapabilities 
                  } 
                }));
              }
              window.pendingConsumes = [];
            }
            return;
          }
          
          if (!sendTransport && (mode === 'both' || mode === 'send')) {
            sendTransport = device.createSendTransport({
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
              iceServers: []
            });

            sendTransport.on("connect", ({ dtlsParameters }, callback, errCallback) => {
              ws.send(JSON.stringify({ 
                type: "connectTransport", 
                data: { transportId: sendTransport.id, dtlsParameters } 
              }));
              callback();
            });

            sendTransport.on("produce", async ({ kind, rtpParameters }, callback, errCallback) => {
              const produceMsg = { 
                type: "produce", 
                data: { transportId: sendTransport.id, kind, rtpParameters } 
              };
              ws.send(JSON.stringify(produceMsg));
              
              if (!window.produceCallbacks) window.produceCallbacks = [];
              window.produceCallbacks.push(callback);
            });

            updateStatus("Getting user media...");
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: true, 
                video: { 
                  width: { ideal: 1280 },
                  height: { ideal: 720 }
                }
              });
              localVideo.srcObject = stream;
              
              await new Promise((resolve) => {
                if (localVideo.videoWidth > 0) {
                  resolve();
                } else {
                  localVideo.onloadedmetadata = () => resolve();
                }
              });
              
              console.log("Local video ready:", localVideo.videoWidth, "x", localVideo.videoHeight);
              console.log("Stream tracks:", stream.getTracks().map(t => ({
                kind: t.kind,
                label: t.label,
                enabled: t.enabled,
                muted: t.muted,
                readyState: t.readyState
              })));
              
              updateStatus("Producing media...");

              for (const track of stream.getTracks()) {
                console.log("Producing track:", track.kind, track.label, "readyState:", track.readyState);
                const producer = await sendTransport.produce({ track });
                console.log("Producer created:", producer.id, "kind:", producer.kind, "paused:", producer.paused);
                
                producer.on('trackended', () => {
                  console.log('Producer track ended:', producer.id);
                });
                producer.on('transportclose', () => {
                  console.log('Producer transport closed:', producer.id);
                });
              }
              
              console.log("All tracks produced successfully");
            } catch (err) {
              console.error("getUserMedia error:", err);
              updateStatus("Error accessing camera: " + err.message);
              alert("Camera error: " + err.message + "\n\nPlease allow camera access and reload the page.");
              startBtn.disabled = false;
            }
          } 
          else if (!recvTransport) {
            recvTransport = device.createRecvTransport({
              id: data.id,
              iceParameters: data.iceParameters,
              iceCandidates: data.iceCandidates,
              dtlsParameters: data.dtlsParameters,
              iceServers: []
            });

            recvTransport.on("connect", ({ dtlsParameters }, callback, errCallback) => {
              ws.send(JSON.stringify({ 
                type: "connectTransport", 
                data: { transportId: recvTransport.id, dtlsParameters } 
              }));
              callback();
            });

            updateStatus("Ready to receive");
            
            if (window.pendingConsumes && window.pendingConsumes.length > 0) {
              console.log("Processing pending consumes:", window.pendingConsumes);
              for (const producerId of window.pendingConsumes) {
                ws.send(JSON.stringify({ 
                  type: "consume", 
                  data: { 
                    producerId: producerId, 
                    rtpCapabilities: device.rtpCapabilities 
                  } 
                }));
              }
              window.pendingConsumes = [];
            }
          }
        }

        if (type === "produce") {
          if (window.produceCallbacks && window.produceCallbacks.length > 0) {
            const callback = window.produceCallbacks.shift();
            callback({ id: data.id });
          }
          updateStatus("Producing: " + data.id);
        }

        if (type === "newProducer") {
          console.log("New producer detected:", data.producerId, "from peer:", data.socketId);
          updateStatus("New producer detected: " + data.producerId);
          
          if (!recvTransport) {
            console.log("Creating receive transport for new producer");
            ws.send(JSON.stringify({ type: "createWebRtcTransport" }));
            if (!window.pendingConsumes) window.pendingConsumes = [];
            window.pendingConsumes.push(data.producerId);
            console.log("Added to pending consumes. Total pending:", window.pendingConsumes.length);
          } else {
            console.log("Consuming producer immediately:", data.producerId);
            ws.send(JSON.stringify({ 
              type: "consume", 
              data: { 
                producerId: data.producerId, 
                rtpCapabilities: device.rtpCapabilities 
              } 
            }));
          }
        }

        if (type === "consume") {
          if (data.error) {
            console.error("Consume error:", data.error);
            updateStatus("Consume error: " + data.error);
            return;
          }

          console.log("Consuming:", data.kind, "consumer ID:", data.id);

          const consumer = await recvTransport.consume({
            id: data.id,
            producerId: data.producerId,
            kind: data.kind,
            rtpParameters: data.rtpParameters
          });

          consumers[data.id] = consumer;
          console.log("Consumer track:", consumer.track);
          console.log("Track readyState:", consumer.track.readyState);
          console.log("Track enabled:", consumer.track.enabled);

          if (!remoteVideo.srcObject) {
            remoteVideo.srcObject = new MediaStream();
          }
          
          remoteVideo.srcObject.addTrack(consumer.track);
          console.log("Added track to remote video, total tracks:", remoteVideo.srcObject.getTracks().length);
          console.log("Remote video element:", remoteVideo);
          console.log("Remote video srcObject:", remoteVideo.srcObject);
          console.log("All tracks in stream:", remoteVideo.srcObject.getTracks().map(t => ({
            kind: t.kind,
            id: t.id,
            readyState: t.readyState,
            enabled: t.enabled,
            muted: t.muted
          })));
          
          setTimeout(() => {
            console.log("Video element check after 1s:");
            console.log("  paused:", remoteVideo.paused);
            console.log("  muted:", remoteVideo.muted);
            console.log("  readyState:", remoteVideo.readyState);
            console.log("  videoWidth:", remoteVideo.videoWidth);
            console.log("  videoHeight:", remoteVideo.videoHeight);
            console.log("  currentTime:", remoteVideo.currentTime);
            console.log("  srcObject active:", remoteVideo.srcObject?.active);
          }, 1000);
          
          // Force video to play
          remoteVideo.play().then(() => {
            console.log("Remote video playing successfully");
          }).catch(err => {
            console.error("Error playing remote video:", err);
          });

          updateStatus("Consuming: " + data.kind);
        }

        if (type === "connectTransport") {
          updateStatus("Transport connected");
        }

      } catch (err) {
        console.error("Error handling message type:", type, err);
        updateStatus("Error: " + err.message);
      }
    };

  } catch (err) {
    console.error("Error starting:", err);
    updateStatus("Error: " + err.message);
    startBtn.disabled = false;
  }
};