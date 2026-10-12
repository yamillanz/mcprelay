## ADDED Requirements

### Requirement: Identity section

The config SHALL accept an `identity` section: `profile` (a non-empty string, default `local`) and `keys` (a list of `{ key, identity }` entries with non-empty strings; an empty list means no key store), with strict key checking and precise path + field errors. Duplicate `key` values SHALL fail (ambiguous mapping); duplicate identities SHALL be accepted. Error messages and `validate` output SHALL NOT echo key values (NFR-4).

#### Scenario: Defaults apply with no config file
- **WHEN** the session runs with no config file
- **THEN** `identity.profile` is `local` and the key store is empty

#### Scenario: File values apply
- **WHEN** the config sets `identity.profile` and `identity.keys`
- **THEN** the session resolves identities from those values

#### Scenario: Duplicate keys fail with path and field
- **WHEN** two `identity.keys` entries share a key value
- **THEN** startup fails naming `identity.keys` and the duplicate is reported without echoing the key value

#### Scenario: Malformed entries fail with path and field
- **WHEN** a key entry misses `key` or `identity`, or a value is not a non-empty string
- **THEN** startup fails naming the config path and the offending field

#### Scenario: Unknown keys fail with path and field
- **WHEN** the `identity` section or a key entry contains an unknown key
- **THEN** startup fails naming the config path and the offending field

#### Scenario: Key values never appear in errors
- **WHEN** validation fails for any reason involving `identity.keys`
- **THEN** the error text contains no key value
