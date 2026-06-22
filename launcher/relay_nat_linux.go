//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const (
	natTunName = "browseros0"
	natTunMTU  = 1500
)

var (
	natEnabled bool
	natTun     *os.File
	natOutIf   string
	natMu      sync.Mutex
	natByIP    = map[string]*rclient{}
)

// ---------- TUN (Linux) ----------
const (
	cIFF_TUN   = 0x0001
	cIFF_NO_PI = 0x1000
	cTUNSETIFF = 0x400454ca
)

type ifreq struct {
	name  [16]byte
	flags uint16
	_     [22]byte
}

func openTUN(name string) (*os.File, error) {
	f, err := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	var req ifreq
	copy(req.name[:], name)
	req.flags = cIFF_TUN | cIFF_NO_PI
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), uintptr(cTUNSETIFF), uintptr(unsafe.Pointer(&req)))
	if errno != 0 {
		f.Close()
		return nil, fmt.Errorf("TUNSETIFF: %v", errno)
	}
	return f, nil
}

func natRun(args ...string) {
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		fmt.Printf("  [nat warn] %s: %v %s\n", strings.Join(args, " "), err, out)
	}
}

func defaultIface() string {
	out, err := exec.Command("sh", "-c", "ip route show default | awk '{print $5; exit}'").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// initRelayNAT sets up TUN + iptables when running as root on Linux.
// Returns a short status line for the launcher banner (empty if NAT unavailable).
func initRelayNAT() string {
	if os.Geteuid() != 0 {
		return "inter-VM only (re-run with sudo for VM internet)"
	}

	var err error
	natTun, err = openTUN(natTunName)
	if err != nil {
		fmt.Printf("  [nat] TUN unavailable (%v) — inter-VM relay only\n", err)
		return "inter-VM only (TUN failed — need /dev/net/tun and root)"
	}

	natRun("ip", "addr", "add", relayGateway+"/24", "dev", natTunName)
	natRun("ip", "link", "set", "dev", natTunName, "mtu", fmt.Sprint(natTunMTU), "up")

	natRun("sysctl", "-w", "net.ipv4.ip_forward=1")
	natOutIf = defaultIface()
	if natOutIf != "" {
		natRun("iptables", "-t", "nat", "-A", "POSTROUTING", "-s", relaySubnet+".0/24", "-o", natOutIf, "-j", "MASQUERADE")
		natRun("iptables", "-A", "FORWARD", "-i", natTunName, "-o", natOutIf, "-j", "ACCEPT")
		natRun("iptables", "-A", "FORWARD", "-i", natOutIf, "-o", natTunName, "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT")
	} else {
		fmt.Println("  [nat warn] no default route interface — internet NAT may not work")
	}

	natEnabled = true
	go natTunToVMs()

	if natOutIf != "" {
		return fmt.Sprintf("internet NAT ON (%s.0/24 -> %s)", relaySubnet, natOutIf)
	}
	return "internet NAT ON (no default interface detected)"
}

func relayNatEnabled() bool { return natEnabled }

func relayNatRegisterIP(c *rclient, ip string) {
	if !natEnabled || ip == "" {
		return
	}
	natMu.Lock()
	natByIP[ip] = c
	natMu.Unlock()
}

func relayNatUnregister(c *rclient) {
	if !natEnabled {
		return
	}
	natMu.Lock()
	if c.ip != "" {
		delete(natByIP, c.ip)
	}
	natMu.Unlock()
}

// relayNatTryForward sends gateway-bound IPv4 frames to the TUN device (outbound internet).
func relayNatTryForward(_ *rclient, f []byte) bool {
	if !natEnabled || natTun == nil || len(f) < 14 {
		return false
	}
	dst := rMacStr(f[0:6])
	if dst != rMacStr(relayGwMAC) || f[12] != 0x08 || f[13] != 0x00 {
		return false
	}
	_, _ = natTun.Write(f[14:])
	return true
}

func natTunToVMs() {
	buf := make([]byte, 65536)
	for {
		n, err := natTun.Read(buf)
		if err != nil {
			return
		}
		if n < 20 {
			continue
		}
		pkt := buf[:n]
		dstIP := fmt.Sprintf("%d.%d.%d.%d", pkt[16], pkt[17], pkt[18], pkt[19])
		natMu.Lock()
		c := natByIP[dstIP]
		natMu.Unlock()
		if c == nil || c.mac == "" {
			continue
		}
		dstMac := rMacParse(c.mac)
		if dstMac == nil {
			continue
		}
		frame := make([]byte, 14+n)
		copy(frame[0:], dstMac)
		copy(frame[6:], relayGwMAC)
		frame[12], frame[13] = 0x08, 0x00
		copy(frame[14:], pkt)
		c.send(frame)
	}
}

func shutdownRelayNAT() {
	if !natEnabled {
		return
	}
	if natOutIf != "" {
		natRun("iptables", "-t", "nat", "-D", "POSTROUTING", "-s", relaySubnet+".0/24", "-o", natOutIf, "-j", "MASQUERADE")
		natRun("iptables", "-D", "FORWARD", "-i", natTunName, "-o", natOutIf, "-j", "ACCEPT")
		natRun("iptables", "-D", "FORWARD", "-i", natOutIf, "-o", natTunName, "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT")
	}
	natRun("ip", "link", "del", natTunName)
	if natTun != nil {
		natTun.Close()
	}
	natEnabled = false
}
