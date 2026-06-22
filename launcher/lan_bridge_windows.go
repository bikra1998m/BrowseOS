//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const pcapErrorBufferSize = 256

type windowsLANDescription struct {
	Interface  string `json:"interface"`
	GUID       string `json:"guid"`
	MAC        string `json:"mac"`
	IP         string `json:"ip"`
	Prefix     int    `json:"prefix"`
	Gateway    string `json:"gateway"`
	GatewayMAC string `json:"gatewayMac"`
	DNS        string `json:"dns"`
}

type windowsPcapPort struct {
	handle uintptr
	nextEx *syscall.LazyProc
	send   *syscall.LazyProc
	getErr *syscall.LazyProc
	close  *syscall.LazyProc
	mu     sync.Mutex
}

type pcapInterface struct {
	Next        *pcapInterface
	Name        *byte
	Description *byte
	Addresses   uintptr
	Flags       uint32
}

type pcapPacketHeader struct {
	Seconds      int32
	Microseconds int32
	Captured     uint32
	Original     uint32
}

func discoverWindowsLAN() (lanHostConfig, error) {
	script := `$c=Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -and $_.IPv4Address} | Select-Object -First 1;` +
		`if(-not $c){exit 2};$a=Get-NetAdapter -InterfaceIndex $c.InterfaceIndex;` +
		`[pscustomobject]@{interface=$a.Name;guid=$a.InterfaceGuid.ToString();mac=$a.MacAddress;` +
		`ip=$c.IPv4Address.IPAddress;prefix=$c.IPv4Address.PrefixLength;` +
		`gateway=$c.IPv4DefaultGateway.NextHop;gatewayMac=((Get-NetNeighbor -InterfaceIndex $c.InterfaceIndex ` +
		`-IPAddress $c.IPv4DefaultGateway.NextHop -ErrorAction SilentlyContinue).LinkLayerAddress);` +
		`dns=(($c.DNSServer.ServerAddresses | ` +
		`Where-Object {$_ -match '^\d+\.'}) -join ',')} | ConvertTo-Json -Compress`
	command := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-Command", script,
	)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.Output()
	if err != nil {
		return lanHostConfig{}, fmt.Errorf("could not discover the active Windows LAN adapter: %w", err)
	}
	var description windowsLANDescription
	if err := json.Unmarshal(output, &description); err != nil {
		return lanHostConfig{}, fmt.Errorf("invalid Windows LAN adapter description: %w", err)
	}
	hostIP := net.ParseIP(description.IP).To4()
	gateway := net.ParseIP(description.Gateway).To4()
	mac, err := net.ParseMAC(strings.ReplaceAll(description.MAC, "-", ":"))
	gatewayMAC, gatewayMACError := net.ParseMAC(strings.ReplaceAll(description.GatewayMAC, "-", ":"))
	if gatewayMACError != nil {
		gatewayMAC = nil
	}
	if hostIP == nil || gateway == nil || err != nil || description.Prefix < 8 || description.Prefix > 30 {
		return lanHostConfig{}, fmt.Errorf("the active adapter has an unsupported IPv4 configuration")
	}
	dns := make([]net.IP, 0, 2)
	for _, value := range strings.Split(description.DNS, ",") {
		if parsed := net.ParseIP(strings.TrimSpace(value)).To4(); parsed != nil {
			dns = append(dns, parsed)
		}
	}
	guid := strings.Trim(strings.TrimSpace(description.GUID), "{}")
	return lanHostConfig{
		Interface:  description.Interface,
		Device:     `\Device\NPF_{` + strings.ToUpper(guid) + `}`,
		HostIP:     hostIP,
		Prefix:     description.Prefix,
		Gateway:    gateway,
		GatewayMAC: gatewayMAC,
		DNS:        dns,
		MAC:        mac,
	}, nil
}

func openLANPacketPort() (lanPacketPort, lanHostConfig, error) {
	config, err := discoverWindowsLAN()
	if err != nil {
		return nil, lanHostConfig{}, err
	}
	windowsDirectory := os.Getenv("WINDIR")
	if windowsDirectory == "" {
		windowsDirectory = `C:\Windows`
	}
	dllPath := filepath.Join(windowsDirectory, "System32", "Npcap", "wpcap.dll")
	dllDirectory := filepath.Dir(dllPath)
	if _, err := os.Stat(dllPath); err != nil {
		return nil, lanHostConfig{}, fmt.Errorf("Npcap is required for real bridged networking")
	}
	directoryPointer, _ := syscall.UTF16PtrFromString(dllDirectory)
	setDLLDirectory := syscall.NewLazyDLL("kernel32.dll").NewProc("SetDllDirectoryW")
	setDLLDirectory.Call(uintptr(unsafe.Pointer(directoryPointer)))
	dll := syscall.NewLazyDLL(dllPath)
	openLive := dll.NewProc("pcap_open_live")
	findAll := dll.NewProc("pcap_findalldevs")
	freeAll := dll.NewProc("pcap_freealldevs")
	nextEx := dll.NewProc("pcap_next_ex")
	send := dll.NewProc("pcap_sendpacket")
	getErr := dll.NewProc("pcap_geterr")
	closeProc := dll.NewProc("pcap_close")
	if err := dll.Load(); err != nil {
		return nil, lanHostConfig{}, fmt.Errorf("could not load Npcap: %w", err)
	}
	errorBuffer := make([]byte, pcapErrorBufferSize)
	var interfaces *pcapInterface
	result, _, _ := findAll.Call(
		uintptr(unsafe.Pointer(&interfaces)),
		uintptr(unsafe.Pointer(&errorBuffer[0])),
	)
	if int32(result) != 0 {
		return nil, lanHostConfig{}, fmt.Errorf(
			"Npcap adapter discovery failed: %s",
			strings.TrimRight(string(errorBuffer), "\x00"),
		)
	}
	defer freeAll.Call(uintptr(unsafe.Pointer(interfaces)))
	wantedGUID := strings.TrimSuffix(
		strings.TrimPrefix(strings.ToUpper(config.Device), `\DEVICE\NPF_{`),
		"}",
	)
	available := make([]string, 0, 8)
	for current := interfaces; current != nil; current = current.Next {
		name := cString(current.Name)
		available = append(available, name)
		if strings.Contains(strings.ToUpper(name), wantedGUID) {
			config.Device = name
			break
		}
	}
	if !strings.Contains(strings.ToUpper(config.Device), wantedGUID) {
		return nil, lanHostConfig{}, fmt.Errorf(
			"Npcap did not expose the %s adapter (available: %s)",
			config.Interface,
			strings.Join(available, ", "),
		)
	}
	device, _ := syscall.BytePtrFromString(config.Device)
	for index := range errorBuffer {
		errorBuffer[index] = 0
	}
	handle, _, _ := openLive.Call(
		uintptr(unsafe.Pointer(device)),
		65536,
		1,
		100,
		uintptr(unsafe.Pointer(&errorBuffer[0])),
	)
	if handle == 0 {
		message := strings.TrimRight(string(errorBuffer), "\x00")
		if message == "" {
			message = "access denied or adapter unavailable"
		}
		return nil, lanHostConfig{}, fmt.Errorf("Npcap could not open %s: %s", config.Interface, message)
	}
	return &windowsPcapPort{
		handle: handle,
		nextEx: nextEx,
		send:   send,
		getErr: getErr,
		close:  closeProc,
	}, config, nil
}

func (port *windowsPcapPort) ReadPacket() ([]byte, error) {
	for {
		var header *pcapPacketHeader
		var data *byte
		result, _, _ := port.nextEx.Call(
			port.handle,
			uintptr(unsafe.Pointer(&header)),
			uintptr(unsafe.Pointer(&data)),
		)
		switch int32(result) {
		case 1:
			if header == nil || data == nil || header.Captured == 0 {
				continue
			}
			raw := unsafe.Slice(data, int(header.Captured))
			return append([]byte(nil), raw...), nil
		case 0:
			continue
		case -2:
			return nil, fmt.Errorf("Npcap capture ended")
		default:
			messagePointer, _, _ := port.getErr.Call(port.handle)
			message := "Npcap capture failed"
			if messagePointer != 0 {
				message = cString((*byte)(unsafe.Pointer(messagePointer)))
			}
			return nil, fmt.Errorf("%s", message)
		}
	}
}

func (port *windowsPcapPort) WritePacket(packet []byte) error {
	if len(packet) == 0 {
		return nil
	}
	port.mu.Lock()
	defer port.mu.Unlock()
	result, _, _ := port.send.Call(
		port.handle,
		uintptr(unsafe.Pointer(&packet[0])),
		uintptr(len(packet)),
	)
	if int32(result) != 0 {
		return fmt.Errorf("Npcap packet injection failed")
	}
	return nil
}

func (port *windowsPcapPort) Close() {
	port.mu.Lock()
	defer port.mu.Unlock()
	if port.handle != 0 {
		port.close.Call(port.handle)
		port.handle = 0
	}
}

func cString(pointer *byte) string {
	if pointer == nil {
		return ""
	}
	length := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(pointer), length)) != 0 {
		length++
	}
	return string(unsafe.Slice(pointer, length))
}
