// SPDX-License-Identifier: AGPL-3.0-only
//! LAN room relay. The owner's extension drives it over native messaging; participants connect over
//! WebSocket. It binds one private or loopback IPv4 address, forwards opaque frames that the browsers
//! encrypt and authenticate (runtime/chrome-extension/lan-room.mjs), and never sees project plaintext.
//! A participant's extension can also drive it (op "connect"): it opens that WebSocket itself, because Chrome's
//! local-network rules block extension pages from connecting to another computer on the LAN.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{collections::{HashMap, VecDeque}, fs::File, io::{self, Read, Write}, net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};

const ORIGIN: &str = "chrome-extension://oekjjadnainlmdbgbdjokegaikafafke/";
const WS_ORIGIN: &str = "chrome-extension://oekjjadnainlmdbgbdjokegaikafafke";
const MAX_FRAME: usize = 512 * 1024;
const MAX_CONNECTIONS: usize = 16;
const MAX_UNADMITTED: usize = 4;
const MAX_ATTEMPTS: usize = 30; // per ATTEMPT_WINDOW, across all addresses
const ATTEMPT_WINDOW: Duration = Duration::from_secs(10);
const ADMIT_WITHIN: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

type Output = Arc<Mutex<io::Stdout>>;
struct Peer { writer: TcpStream, admitted: bool, announced: bool, since: Instant }
type Peers = Arc<Mutex<HashMap<u32, Peer>>>;
struct Room { closed: Arc<AtomicBool>, thread: Option<thread::JoinHandle<()>>, peers: Peers }
impl Drop for Room {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
        for peer in self.peers.lock().map(|mut peers| peers.drain().map(|(_, peer)| peer).collect::<Vec<_>>()).unwrap_or_default() {
            let _ = peer.writer.shutdown(Shutdown::Both);
        }
    }
}

fn send(output: &Output, value: Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(&value)?;
    if bytes.len() > 900_000 { return Err(io::Error::other("Output frame too large")); }
    let mut out = output.lock().map_err(|_| io::Error::other("Output closed"))?;
    out.write_all(&(bytes.len() as u32).to_ne_bytes())?; out.write_all(&bytes)?; out.flush()
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> { value[key].as_str().ok_or_else(|| format!("Missing {key}")) }
fn peer_id(value: &Value) -> Result<u32, String> { value["peer"].as_u64().and_then(|id| u32::try_from(id).ok()).ok_or_else(|| "Invalid peer".into()) }
fn private(ip: Ipv4Addr) -> bool { ip.is_loopback() || ip.is_private() || ip.is_link_local() }
fn valid_room(room: &str) -> bool { room.len() == 22 && room.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') }
fn bind_address(value: &str) -> Result<Ipv4Addr, String> {
    value.parse::<Ipv4Addr>().ok().filter(|ip| private(*ip)).ok_or_else(|| "Sharing is limited to this computer or a private local network address".into())
}
/// Loopback plus the private address of the default route; the UDP connect sends no packet.
fn addresses() -> Vec<String> {
    let mut list = vec![Ipv4Addr::LOCALHOST.to_string()];
    let routed = UdpSocket::bind("0.0.0.0:0").and_then(|socket| { socket.connect("192.0.2.1:9")?; socket.local_addr() });
    if let Ok(address) = routed { if let IpAddr::V4(ip) = address.ip() { if private(ip) && !ip.is_loopback() { list.push(ip.to_string()); } } }
    list
}
pub fn accept_key(key: &str) -> String {
    let mut hash = Sha1::new(); hash.update(key.as_bytes()); hash.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    STANDARD.encode(hash.finalize())
}
/// Accepts only `GET /r/<room>` WebSocket upgrades from the extension's own origin.
fn handshake(stream: &mut TcpStream, room: &str) -> Result<(), ()> {
    let mut request = Vec::with_capacity(1024); let mut byte = [0u8; 1];
    while !request.ends_with(b"\r\n\r\n") {
        if request.len() >= 8192 || stream.read(&mut byte).map_err(|_| ())? == 0 { return Err(()); }
        request.push(byte[0]);
    }
    let accepted = parse_upgrade(&request, room);
    let response = match &accepted {
        Some(key) => format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n", accept_key(key)),
        None => "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    };
    stream.write_all(response.as_bytes()).map_err(|_| ())?;
    accepted.map(|_| ()).ok_or(())
}
pub fn parse_upgrade(request: &[u8], room: &str) -> Option<String> {
    let request = std::str::from_utf8(request).ok()?;
    let mut lines = request.split("\r\n");
    if lines.next()? != format!("GET /r/{room} HTTP/1.1") { return None; }
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':')?;
        if headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string()).is_some() { return None; }
    }
    let key = headers.get("sec-websocket-key")?;
    let ok = headers.get("upgrade")?.eq_ignore_ascii_case("websocket") && headers.get("sec-websocket-version")? == "13" &&
        headers.get("origin")? == WS_ORIGIN && STANDARD.decode(key).is_ok_and(|bytes| bytes.len() == 16);
    ok.then(|| key.clone())
}
#[derive(Debug, PartialEq)]
pub enum Frame { Binary(Vec<u8>), Ping(Vec<u8>), Pong, Close }
/// Reads one masked client message: a whole binary frame, or binary + continuation fragments (Chrome splits large messages),
/// bounded by MAX_FRAME in total; or one control frame. Anything else is a protocol violation.
pub fn read_frame(reader: &mut impl Read) -> Result<Frame, ()> { read_frame_masked(reader, true) }
/// As read_frame; `masked` is false when reading the owner's (server) frames as a participant.
pub fn read_frame_masked(reader: &mut impl Read, masked_expected: bool) -> Result<Frame, ()> {
    let mut message: Option<Vec<u8>> = None;
    loop {
        let mut head = [0u8; 2]; reader.read_exact(&mut head).map_err(|_| ())?;
        let (fin, reserved, op, masked) = (head[0] & 0x80 != 0, head[0] & 0x70, head[0] & 0x0f, head[1] & 0x80 != 0);
        if reserved != 0 || masked != masked_expected || (op >= 8 && !fin) { return Err(()); }
        let mut length = u64::from(head[1] & 0x7f);
        if length == 126 { let mut b = [0u8; 2]; reader.read_exact(&mut b).map_err(|_| ())?; length = u64::from(u16::from_be_bytes(b)); }
        else if length == 127 { let mut b = [0u8; 8]; reader.read_exact(&mut b).map_err(|_| ())?; length = u64::from_be_bytes(b); }
        let held = if op < 8 { message.as_ref().map_or(0, Vec::len) as u64 } else { 0 };
        if held + length > MAX_FRAME as u64 || (op >= 8 && length > 125) { return Err(()); }
        let mut mask = [0u8; 4]; if masked { reader.read_exact(&mut mask).map_err(|_| ())?; }
        let mut payload = vec![0u8; length as usize]; reader.read_exact(&mut payload).map_err(|_| ())?;
        for (index, byte) in payload.iter_mut().enumerate() { *byte ^= mask[index % 4]; }
        match (op, message.as_mut()) {
            (2, None) if fin => return Ok(Frame::Binary(payload)),
            (2, None) => message = Some(payload),
            (0, Some(held)) => { held.extend_from_slice(&payload); if fin { return Ok(Frame::Binary(message.take().unwrap_or_default())); } },
            (8, _) => return Ok(Frame::Close),
            (9, None) => return Ok(Frame::Ping(payload)),
            (10, _) => if message.is_none() { return Ok(Frame::Pong) },
            // shortcut: a ping inside a fragmented message is refused (Chrome clients do not send pings); answer it if a client needs that.
            _ => return Err(()),
        }
    }
}
pub fn frame(op: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0x80 | op];
    match payload.len() {
        n if n < 126 => bytes.push(n as u8),
        n if n <= 0xffff => { bytes.push(126); bytes.extend((n as u16).to_be_bytes()); },
        n => { bytes.push(127); bytes.extend((n as u64).to_be_bytes()); },
    }
    bytes.extend_from_slice(payload); bytes
}
fn write_to(peers: &Peers, id: u32, bytes: &[u8]) -> Result<(), String> {
    let mut peers = peers.lock().map_err(|_| "Room closed")?;
    let peer = peers.get_mut(&id).filter(|peer| peer.announced).ok_or("Participant left")?;
    if peer.writer.write_all(bytes).is_err() { let _ = peer.writer.shutdown(Shutdown::Both); return Err("Participant connection failed".into()); }
    Ok(())
}
fn serve_peer(mut stream: TcpStream, id: u32, room: &str, peers: &Peers, output: &Output) -> Result<(), ()> {
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(|_| ())?;
    handshake(&mut stream, room)?;
    let address = stream.peer_addr().map(|address| address.ip().to_string()).map_err(|_| ())?;
    peers.lock().map_err(|_| ())?.get_mut(&id).ok_or(())?.announced = true;
    send(output, json!({"ev": "peer", "peer": id, "address": address})).map_err(|_| ())?;
    stream.set_read_timeout(Some(IDLE_TIMEOUT)).map_err(|_| ())?;
    loop {
        match read_frame(&mut stream)? {
            Frame::Binary(bytes) => send(output, json!({"ev": "data", "peer": id, "data": STANDARD.encode(bytes)})).map_err(|_| ())?,
            Frame::Ping(bytes) => write_to(peers, id, &frame(10, &bytes)).map_err(|_| ())?,
            Frame::Pong => (),
            Frame::Close => { let _ = write_to(peers, id, &frame(8, &[])); return Ok(()); },
        }
    }
}
fn accept_loop(listener: TcpListener, room: String, peers: Peers, output: Output, closed: Arc<AtomicBool>) {
    let mut next = 1u32; let mut attempts: VecDeque<Instant> = VecDeque::new();
    while !closed.load(Ordering::Relaxed) {
        if let Ok(map) = peers.lock() {
            // Shut down participants that did not authenticate in time; their reader thread removes them.
            for peer in map.values().filter(|peer| !peer.admitted && peer.since.elapsed() >= ADMIT_WITHIN) { let _ = peer.writer.shutdown(Shutdown::Both); }
        }
        let (stream, _) = match listener.accept() { Ok(accepted) => accepted, Err(_) => { thread::sleep(Duration::from_millis(25)); continue; } };
        let now = Instant::now();
        while attempts.front().is_some_and(|time| now.duration_since(*time) > ATTEMPT_WINDOW) { attempts.pop_front(); }
        attempts.push_back(now);
        let Ok(mut map) = peers.lock() else { return };
        let unadmitted = map.values().filter(|peer| !peer.admitted).count();
        // Accepted sockets inherit the listener's non-blocking mode on macOS/BSD.
        let ready = stream.set_nonblocking(false).and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT))).and_then(|_| stream.try_clone());
        let (Ok(writer), true) = (ready, attempts.len() <= MAX_ATTEMPTS && map.len() < MAX_CONNECTIONS && unadmitted < MAX_UNADMITTED) else { continue };
        let id = next; next = next.wrapping_add(1).max(1);
        map.insert(id, Peer { writer, admitted: false, announced: false, since: now });
        drop(map);
        let (room, peers, output) = (room.clone(), Arc::clone(&peers), Arc::clone(&output));
        thread::spawn(move || {
            let _ = serve_peer(stream, id, &room, &peers, &output);
            let removed = peers.lock().ok().and_then(|mut map| map.remove(&id));
            if let Some(peer) = removed { let _ = peer.writer.shutdown(Shutdown::Both); if peer.announced { let _ = send(&output, json!({"ev": "gone", "peer": id})); } }
        });
    }
}
fn open(value: &Value, output: &Output) -> Result<(Room, u16), String> {
    let ip = bind_address(text(value, "bind")?)?;
    let port = value["port"].as_u64().and_then(|port| u16::try_from(port).ok()).filter(|port| *port == 0 || *port >= 1024).ok_or("Invalid port")?;
    let room = text(value, "room")?; if !valid_room(room) { return Err("Invalid room".into()); }
    let listener = TcpListener::bind((ip, port)).map_err(|_| "That address or port is unavailable")?;
    listener.set_nonblocking(true).map_err(|_| "Listener setup failed")?;
    let port = listener.local_addr().map_err(|_| "Listener setup failed")?.port();
    let (closed, peers) = (Arc::new(AtomicBool::new(false)), Peers::default());
    let (flag, map, out, room) = (Arc::clone(&closed), Arc::clone(&peers), Arc::clone(output), room.to_string());
    let thread = thread::spawn(move || accept_loop(listener, room, map, out, flag));
    Ok((Room { closed, thread: Some(thread), peers }, port))
}
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N]; File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|_| "No random source")?; Ok(bytes)
}
/// A masked client frame, as RFC 6455 requires of a participant.
fn client_frame(op: u8, payload: &[u8]) -> Result<Vec<u8>, String> {
    let mask: [u8; 4] = random()?;
    let mut bytes = frame(op, &[]); bytes.truncate(1); // header byte only; the length is rewritten with the mask bit
    match payload.len() {
        n if n < 126 => bytes.push(0x80 | n as u8),
        n if n <= 0xffff => { bytes.push(0x80 | 126); bytes.extend((n as u16).to_be_bytes()); },
        n => { bytes.push(0x80 | 127); bytes.extend((n as u64).to_be_bytes()); },
    }
    bytes.extend(mask); bytes.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4])); Ok(bytes)
}
/// "ws://<private IPv4>:<port>/r/<room>" only; the same shape lan-room.mjs's parseJoinLink produces.
pub fn parse_target(url: &str) -> Option<(SocketAddr, String)> {
    let rest = url.strip_prefix("ws://")?; let (authority, path) = rest.split_once('/')?;
    let (host, port) = authority.split_once(':')?; let room = path.strip_prefix("r/")?;
    let ip: Ipv4Addr = host.parse().ok().filter(|ip| private(*ip))?; let port: u16 = port.parse().ok().filter(|port| *port >= 1024)?;
    valid_room(room).then(|| (SocketAddr::from((ip, port)), room.to_string()))
}
/// Participant: connect, upgrade with the extension's Origin, check the owner's accept key; then relay the owner's frames.
fn connect(value: &Value, output: &Output) -> Result<TcpStream, String> {
    let (address, room) = parse_target(text(value, "url")?).ok_or("This is not a valid join link")?;
    let mut stream = TcpStream::connect_timeout(&address, IO_TIMEOUT).map_err(|_| "Cannot reach the owner at this link")?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).and_then(|_| stream.set_write_timeout(Some(IO_TIMEOUT))).map_err(|_| "Connection setup failed")?;
    let key = STANDARD.encode(random::<16>()?);
    write!(stream, "GET /r/{room} HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {WS_ORIGIN}\r\n\r\n")
        .map_err(|_| "Cannot reach the owner at this link")?;
    let mut response = Vec::with_capacity(256); let mut byte = [0u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        if response.len() >= 8192 || stream.read(&mut byte).map_err(|_| "The owner did not answer")? == 0 { return Err("The owner refused the connection".into()); }
        response.push(byte[0]);
    }
    let response = String::from_utf8_lossy(&response); let expected = accept_key(&key);
    let accepted = response.starts_with("HTTP/1.1 101 ") && response.split("\r\n").any(|line| line.split_once(':').is_some_and(|(name, value)| name.trim().eq_ignore_ascii_case("sec-websocket-accept") && value.trim() == expected));
    if !accepted { return Err("The owner refused the connection".into()); }
    stream.set_read_timeout(Some(IDLE_TIMEOUT)).map_err(|_| "Connection setup failed")?;
    let mut reader = stream.try_clone().map_err(|_| "Connection setup failed")?; let out = Arc::clone(output);
    thread::spawn(move || {
        while let Ok(Frame::Binary(bytes)) = read_frame_masked(&mut reader, false) { if send(&out, json!({"ev": "data", "data": STANDARD.encode(bytes)})).is_err() { break; } }
        let _ = reader.shutdown(Shutdown::Both); let _ = send(&out, json!({"ev": "closed"}));
    });
    Ok(stream)
}
fn serve() -> Result<(), String> {
    let output: Output = Arc::new(Mutex::new(io::stdout()));
    let mut input = io::stdin().lock(); let mut room: Option<Room> = None; let mut client: Option<TcpStream> = None;
    loop {
        let mut header = [0; 4];
        match input.read_exact(&mut header) { Ok(()) => (), Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break, Err(_) => return Err("Input closed".into()) }
        let length = u32::from_ne_bytes(header) as usize;
        if length == 0 || length > 1_000_000 { return Err("Invalid frame length".into()); }
        let mut bytes = vec![0; length]; input.read_exact(&mut bytes).map_err(|_| "Incomplete frame")?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid message")?;
        let op = text(&value, "op")?;
        if op == "send" && value.get("peer").is_none() { // participant: to the owner; a failure closes the reader, which reports "closed"
            if let (Some(stream), Some(data)) = (client.as_mut(), value["data"].as_str()) {
                if let Ok(bytes) = STANDARD.decode(data) { if !bytes.is_empty() && bytes.len() <= MAX_FRAME { if let Ok(f) = client_frame(2, &bytes) { if stream.write_all(&f).is_err() { let _ = stream.shutdown(Shutdown::Both); } } } }
            }
            continue;
        }
        if op == "send" { // fire-and-forget; a failed peer produces a "gone" event from its reader
            let (Some(open), Ok(id), Some(data)) = (&room, peer_id(&value), value["data"].as_str()) else { continue };
            if let Ok(bytes) = STANDARD.decode(data) { if !bytes.is_empty() && bytes.len() <= MAX_FRAME { let _ = write_to(&open.peers, id, &frame(2, &bytes)); } }
            continue;
        }
        let id = value["id"].as_u64().ok_or("Invalid request ID")?;
        let result: Result<Value, String> = (|| match op {
            "addresses" => Ok(json!({"addresses": addresses()})),
            "open" => {
                if room.is_some() { return Err("Sharing is already on".into()); }
                let (opened, port) = open(&value, &output)?; room = Some(opened); Ok(json!({"port": port}))
            },
            "admit" | "drop" => {
                let open = room.as_ref().ok_or("Sharing is off")?; let peer = peer_id(&value)?;
                let mut peers = open.peers.lock().map_err(|_| "Room closed")?;
                let entry = peers.get_mut(&peer).ok_or("Participant left")?;
                if op == "admit" { entry.admitted = true; } else { let _ = entry.writer.shutdown(Shutdown::Both); }
                Ok(json!({"peer": peer}))
            },
            "connect" => {
                if room.is_some() || client.is_some() { return Err("Already connected".into()); }
                client = Some(connect(&value, &output)?); Ok(json!({"connected": true}))
            },
            "close" => { room = None; if let Some(stream) = client.take() { if let Ok(f) = client_frame(8, &[]) { let _ = (&stream).write_all(&f); } let _ = stream.shutdown(Shutdown::Both); } Ok(json!({"closed": true})) },
            _ => Err("Unknown sharing operation".into()),
        })();
        match result {
            Ok(value) => send(&output, json!({"id": id, "result": value})),
            Err(error) => send(&output, json!({"id": id, "error": error})),
        }.map_err(|_| "Output closed")?;
    }
    drop(room); // closing the extension page stops sharing
    if let Some(stream) = client { let _ = stream.shutdown(Shutdown::Both); }
    Ok(())
}
fn main() {
    if std::env::args().nth(1).as_deref() != Some(ORIGIN) { eprintln!("Unrecognized extension origin"); std::process::exit(1); }
    if serve().is_err() { eprintln!("LAN sharing helper disconnected"); std::process::exit(1); }
}

#[cfg(test)] mod tests {
    use super::*;
    fn masked(op: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mut bytes = frame(op, payload); if !fin { bytes[0] &= 0x7f; }
        let at = bytes.len() - payload.len(); bytes[1] |= 0x80;
        let mask = [1u8, 2, 3, 4]; let body: Vec<u8> = payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]).collect();
        bytes.truncate(at); bytes.extend(mask); bytes.extend(body); bytes
    }
    #[test] fn accept_key_matches_rfc6455() { assert_eq!(accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="); }
    #[test] fn binds_only_private_or_loopback_ipv4() {
        for ok in ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.20", "169.254.3.4"] { assert!(bind_address(ok).is_ok(), "{ok}"); }
        for bad in ["0.0.0.0", "8.8.8.8", "172.32.0.1", "::1", "192.168.1.20:80", "localhost", ""] { assert!(bind_address(bad).is_err(), "{bad}"); }
    }
    #[test] fn upgrade_requires_room_origin_and_key() {
        let room = "AbCdEfGhIjKlMnOpQrStUv";
        let request = |path: &str, origin: &str| format!("GET {path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n");
        assert!(parse_upgrade(request(&format!("/r/{room}"), WS_ORIGIN).as_bytes(), room).is_some());
        assert!(parse_upgrade(request("/r/AAAAAAAAAAAAAAAAAAAAAA", WS_ORIGIN).as_bytes(), room).is_none());
        assert!(parse_upgrade(request(&format!("/r/{room}"), "http://192.168.1.5").as_bytes(), room).is_none());
        let duplicate = request(&format!("/r/{room}"), WS_ORIGIN).replace("Origin:", "Origin: x\r\nOrigin:");
        assert!(parse_upgrade(duplicate.as_bytes(), room).is_none());
    }
    #[test] fn frames_must_be_masked_whole_binary_and_bounded() {
        assert_eq!(read_frame(&mut &masked(2, true, b"sealed")[..]), Ok(Frame::Binary(b"sealed".to_vec())));
        assert_eq!(read_frame(&mut &masked(2, true, &vec![7; 70_000])[..]), Ok(Frame::Binary(vec![7; 70_000])));
        assert!(read_frame(&mut &frame(2, b"unmasked")[..]).is_err());
        let joined = [masked(2, false, b"pa"), masked(10, true, b""), masked(0, false, b"r"), masked(0, true, b"t")].concat();
        assert_eq!(read_frame(&mut &joined[..]), Ok(Frame::Binary(b"part".to_vec())));
        assert!(read_frame(&mut &masked(2, false, b"part")[..]).is_err());                       // never finished
        assert!(read_frame(&mut &masked(0, true, b"part")[..]).is_err());                        // continuation without a start
        assert!(read_frame(&mut &[masked(2, false, b"a"), masked(2, true, b"b")].concat()[..]).is_err());
        assert!(read_frame(&mut &[masked(2, false, b"a"), masked(9, true, b"")].concat()[..]).is_err());
        assert!(read_frame(&mut &[masked(2, false, &vec![0; MAX_FRAME]), masked(0, true, b"x")].concat()[..]).is_err()); // bounded in total
        assert!(read_frame(&mut &masked(9, false, b"")[..]).is_err());
        assert!(read_frame(&mut &masked(1, true, b"text")[..]).is_err());
        assert!(read_frame(&mut &masked(2, true, &vec![0; MAX_FRAME + 1])[..]).is_err());
        assert!(read_frame(&mut &masked(9, true, &[0; 126])[..]).is_err());
        assert_eq!(read_frame_masked(&mut &frame(2, b"owner")[..], false), Ok(Frame::Binary(b"owner".to_vec()))); // a participant reads unmasked owner frames
        assert!(read_frame_masked(&mut &masked(2, true, b"x")[..], false).is_err());
        for n in [3usize, 200, 70_000] { let payload = vec![9u8; n]; assert_eq!(read_frame(&mut &client_frame(2, &payload).unwrap()[..]), Ok(Frame::Binary(payload))); }
    }
    #[test] fn join_target_is_private_ws_room_only() {
        let room = "A".repeat(22);
        assert_eq!(parse_target(&format!("ws://192.168.1.9:50000/r/{room}")).map(|(a, r)| (a.to_string(), r)), Some(("192.168.1.9:50000".into(), room.clone())));
        for bad in [format!("ws://8.8.8.8:50000/r/{room}"), format!("wss://10.0.0.1:50000/r/{room}"), format!("ws://10.0.0.1:80/r/{room}"), "ws://10.0.0.1:50000/r/short".into(), format!("ws://example.com:50000/r/{room}")] {
            assert!(parse_target(&bad).is_none(), "{bad}");
        }
    }
}
