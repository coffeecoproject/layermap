// Command go-map analyzes the Go sources of one module for LayerMap.
//
// It reads one JSON request from stdin and writes one JSON result to stdout. It never reads or
// writes the file system and never uses the network: every source comes from the request.
// Positions are byte offsets; the caller converts them to its own anchors and identities.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type request struct {
	Operation string            `json:"operation"`
	ModFile   string            `json:"modFile"`
	Files     map[string]string `json:"files"`
	Target    *target           `json:"target"`
}

type target struct {
	Path   string `json:"path"`
	Offset int    `json:"offset"`
}

func main() {
	var input request
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&input); err != nil {
		fail("PROJECT_MAP_PROTOCOL_INVALID", err)
	}
	program := load(input)
	var output any
	switch input.Operation {
	case "BUILD":
		output = extract(program)
	case "REFERENCES":
		if input.Target == nil {
			fail("PROJECT_MAP_PROTOCOL_INVALID", fmt.Errorf("missing target"))
		}
		references, err := findReferences(program, *input.Target)
		if err != nil {
			fail("PROJECT_MAP_REFERENCE_TARGET_UNAVAILABLE", err)
		}
		output = references
	default:
		fail("PROJECT_MAP_PROTOCOL_INVALID", fmt.Errorf("unknown operation %q", input.Operation))
	}
	encoder := json.NewEncoder(os.Stdout)
	if err := encoder.Encode(output); err != nil {
		fail("PROJECT_MAP_ANALYSIS_FAILED", err)
	}
}

// fail reports a stable code on stderr; the worker turns it into a map failure.
func fail(code string, err error) {
	fmt.Fprintf(os.Stderr, "%s\n%v\n", code, err)
	os.Exit(2)
}
