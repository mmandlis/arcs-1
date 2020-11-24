/**
 * @license
 * Copyright (c) 2020 Google Inc. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * Code distributed by Google as part of this project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import {Manifest} from '../../manifest.js';
import {assert} from '../../../platform/chai-web.js';
import {PolicyRetentionMedium, PolicyAllowedUsageType} from '../policy.js';
import {assertThrowsAsync} from '../../../testing/test-util.js';
import {mapToDictionary} from '../../../utils/lib-utils.js';
import {TtlUnits, Persistence, Encryption, Capabilities, Ttl} from '../../capabilities.js';
import {IngressValidation} from '../ingress-validation.js';
import {deleteFieldRecursively} from '../../../utils/lib-utils.js';

const customAnnotation = `
annotation custom
  targets: [Policy, PolicyTarget, PolicyField]
  retention: Source
  doc: 'custom annotation for testing'
`;

const personSchema = `
schema Person
  name: Text
  age: Number
  friends: [&Friend {name: Text, age: Number}]
`;

async function parsePolicy(str: string) {
  const manifest = await Manifest.parse(customAnnotation + personSchema + str);
  assert.lengthOf(manifest.policies, 1);
  return manifest.policies[0];
}

describe('policy', () => {
  it('can round-trip to string', async () => {
    const manifestString = `
${customAnnotation.trim()}
${personSchema.trim()}
@intendedPurpose(description: 'test')
@egressType(type: 'Logging')
@custom
policy MyPolicy {
  @maxAge(age: '2d')
  @allowedRetention(medium: 'Ram', encryption: false)
  @allowedRetention(medium: 'Disk', encryption: true)
  @custom
  from Person access {
    @allowedUsage(label: 'raw', usageType: 'join')
    @allowedUsage(label: 'truncated', usageType: 'egress')
    friends {
      @allowedUsage(label: 'redacted', usageType: '*')
      @custom
      age,
    },
    @custom
    name,
  }
  config SomeConfig {
    abc: '123'
    def: '456'
  }
}`.trim();
    const manifest = await Manifest.parse(manifestString);
    assert.strictEqual(manifest.toString(), manifestString);
  });

  it('rejects duplicate policy names', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {}
policy MyPolicy {}
`), 'A policy named MyPolicy already exists.');
  });

  it('policy annotations work', async () => {
    const policy = await parsePolicy(`
@intendedPurpose('test')
@egressType('Logging')
@custom
policy MyPolicy {}
`);
    assert.strictEqual(policy.name, 'MyPolicy');
    assert.strictEqual(policy.description, 'test');
    assert.strictEqual(policy.egressType, 'Logging');
    assert.lengthOf(policy.customAnnotations, 1);
    assert.strictEqual(policy.customAnnotations[0].name, 'custom');
  });

  it('handles missing policy annotations', async () => {
    const policy = await parsePolicy(`
policy MyPolicy {}
`);
    assert.isNull(policy.description);
    assert.isNull(policy.egressType);
  });

  it('allows arbitrary egress types', async () => {
    const policy = await parsePolicy(`
@egressType('SomeInventedEgressType')
policy MyPolicy {}
`);
    assert.strictEqual(policy.egressType, 'SomeInventedEgressType');
  });

  it('policy target annotations work', async () => {
    const policy = await parsePolicy(`
policy MyPolicy {
  @allowedRetention(medium: 'Disk', encryption: true)
  @allowedRetention(medium: 'Ram', encryption: false)
  @maxAge('2d')
  @custom
  from Person access {}
}`);
    assert.lengthOf(policy.targets, 1);
    const target = policy.targets[0];
    assert.strictEqual(target.schemaName, 'Person');
    assert.deepStrictEqual(target.retentions, [
      {
        medium: PolicyRetentionMedium.Disk,
        encryptionRequired: true,
      },
      {
        medium: PolicyRetentionMedium.Ram,
        encryptionRequired: false,
      },
    ]);
    assert.strictEqual(target.maxAge.count, 2);
    assert.strictEqual(target.maxAge.units, TtlUnits.Days);
    assert.lengthOf(target.customAnnotations, 1);
    assert.strictEqual(target.customAnnotations[0].name, 'custom');
  });

  it('handles missing target annotations', async () => {
    const policy = await parsePolicy(`
policy MyPolicy {
  from Person access {}
}
`);
    const target = policy.targets[0];
    assert.strictEqual(target.maxAge.millis, 0);
    assert.isEmpty(target.fields);
    assert.isEmpty(target.customAnnotations);
  });

  it('rejects unknown target types', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from UnknownType access {}
}`), `Unknown type name: UnknownType.`);
  });

  it('rejects duplicate targets', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {}
  from Person access {}
}`), `A definition for 'Person' already exists.`);
  });

  it('rejects duplicate retentions', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  @allowedRetention(medium: 'Ram', encryption: true)
  @allowedRetention(medium: 'Ram', encryption: true)
  from Person access {}
}`), '@allowedRetention has already been defined for Ram.');
  });

  it('rejects unknown retention mediums', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  @allowedRetention(medium: 'SomethingElse', encryption: false)
  from Person access {}
}`), 'Expected one of: Ram, Disk. Found: SomethingElse.');
  });

  it('rejects invalid maxAge', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  @maxAge('4x')
  from Person access {}
}`), 'Invalid ttl: 4x');
  });

  it('policy field annotations work', async () => {
    const policy = await parsePolicy(`
policy MyPolicy {
  from Person access {
    @allowedUsage(label: 'redacted', usageType: 'egress')
    @allowedUsage(label: 'redacted', usageType: 'join')
    @custom
    friends {
      @allowedUsage(label: 'truncated', usageType: 'join')
      @custom
      name,

      @allowedUsage(label: 'raw', usageType: '*')
      age,
    }
  }
}`);
    const fields = policy.targets[0].fields;
    assert.lengthOf(fields, 1);

    const friends = fields[0];
    assert.strictEqual(friends.name, 'friends');
    assert.deepStrictEqual(friends.allowedUsages, [
      {
        usage: PolicyAllowedUsageType.Egress,
        label: 'redacted',
      },
      {
        usage: PolicyAllowedUsageType.Join,
        label: 'redacted',
      },
    ]);
    assert.lengthOf(friends.customAnnotations, 1);
    assert.strictEqual(friends.customAnnotations[0].name, 'custom');

    const subfields = friends.subfields;
    assert.lengthOf(subfields, 2);
    const [name, age] = subfields;

    assert.strictEqual(name.name, 'name');
    assert.deepStrictEqual(name.allowedUsages, [{
      usage: PolicyAllowedUsageType.Join,
      label: 'truncated',
    }]);
    assert.lengthOf(name.customAnnotations, 1);
    assert.strictEqual(name.customAnnotations[0].name, 'custom');

    assert.strictEqual(age.name, 'age');
    assert.deepStrictEqual(age.allowedUsages, [{
      usage: PolicyAllowedUsageType.Any,
      label: '',
    }]);
    assert.lengthOf(age.customAnnotations, 0);
  });

  it('rejects unknown fields and subfields', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {
    unknownField,
  }
}`), /Schema 'Person \{.*\}' does not contain field 'unknownField'/);
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {
    friends {
      unknownField,
    }
  }
}`), /Schema 'Friend \{.*\}' does not contain field 'unknownField'/);
  });

  it('rejects unknown usage types', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {
    @allowedUsage(label: 'redacted', usageType: 'SomethingElse')
    age,
  }
}`), 'Expected one of: *, egress, join. Found: SomethingElse.');
  });

  it('rejects duplicate usage types', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {
    @allowedUsage(label: 'redacted', usageType: 'egress')
    @allowedUsage(label: 'redacted', usageType: 'egress')
    age,
  }
}`), `Usage of label 'redacted' for usage type 'egress' has already been allowed.`);
  });

  it('rejects duplicate fields', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {
    abc,
    abc,
  }
}`), `A definition for 'abc' already exists.`);
  });

  it('rejects duplicate subfields', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  from Person access {
    friends,
    friends {
      name
    }
  }
}`), `A definition for 'friends' already exists.`);
  });

  it('allowed usages defaults to any', async () => {
    const policyStr = `
policy MyPolicy {
  from Person access {
    age,
  }
}`.trim();
    const policy = await parsePolicy(policyStr);
    assert.deepStrictEqual(policy.targets[0].fields[0].allowedUsages, [{
      label: '',
      usage: PolicyAllowedUsageType.Any,
    }]);

    assert.strictEqual(policy.toManifestString(), policyStr);
  });

  it('policy configs work', async () => {
    const policy = await parsePolicy(`
policy MyPolicy {
  config MyConfig {
    abc: '123'
    def: '456'
  }
}`);
    assert.lengthOf(policy.configs, 1);
    const config = policy.configs[0];
    assert.strictEqual(config.name, 'MyConfig');
    assert.deepStrictEqual(mapToDictionary(config.metadata), {
      abc: '123',
      def: '456',
    });
  });

  it('rejects duplicate configs', async () => {
    await assertThrowsAsync(async () => parsePolicy(`
policy MyPolicy {
  config Abc {}
  config Abc {}
}`), `A definition for 'Abc' already exists.`);
  });

  it('converts to capabilities', async () => {
    const target = (await parsePolicy(`
policy MyPolicy {
  @allowedRetention(medium: 'Disk', encryption: true)
  @allowedRetention(medium: 'Ram', encryption: false)
  @maxAge('2d')
  @custom
  from Person access {}
}`)).targets[0];
    const capabilities = target.toCapabilities();
    assert.lengthOf(capabilities, 2);
    assert.isTrue(capabilities[0].isEquivalent(Capabilities.create([
        Persistence.onDisk(), new Encryption(true), Ttl.days(2)])),
        `Unexpected capabilities: ${capabilities[0].toDebugString()}`);
    assert.isTrue(capabilities[1].isEquivalent(
        Capabilities.create([Persistence.inMemory(), new Encryption(false), Ttl.days(2)])),
        `Unexpected capabilities: ${capabilities[1].toDebugString()}`);
  });

  it('restricts types according to policy', async () => {
    const manifest = await Manifest.parse(`
      schema Address
        number: Number
        street: Text
        city: Text
        country: Text

      schema Person
        name: Text
        phone: Text
        address: &Address
        otherAddresses: [&Address {street, city, country}]

      policy MyPolicy {
        from Person access {
          name,
          address {
            number
            street,
            city
          },
          otherAddresses {city, country}
        }
      }`);
    const policy = manifest.policies[0];
    const schema = policy.targets[0].getMaxReadSchema();
    const expectedSchemas = (await Manifest.parse(`
      schema Address
        number: Number
        street: Text
        city: Text
        country: Text

      schema Person
        name: Text
        address: &Address {number, street, city}
        otherAddresses: [&Address {city, country}]
      `)).schemas;
    deleteFieldRecursively(schema, 'location');
    deleteFieldRecursively(expectedSchemas, 'location');
    assert.deepEqual(schema, expectedSchemas['Person']);
  });

  it('restricts inline types according to policy', async () => {
    const manifest = await Manifest.parse(`
      schema Address
        number: Number
        street: Text
        city: Text
        country: Text

      schema Name
        first: Text
        last: Text

      schema Person
        name: inline Name
        phone: Text
        addresses: List<inline Address>

      policy MyPolicy {
        from Person access {
          name {
            last
          },
          addresses {
            number
            street,
            city
          },
        }
      }`);
    const policy = manifest.policies[0];
    const schema = policy.targets[0].getMaxReadSchema();
    const expectedSchemas = (await Manifest.parse(`
      schema Person
        name: inline Name {last: Text}
        addresses: List<inline Address {number: Number, street: Text, city: Text}>
      `)).schemas;
    deleteFieldRecursively(schema, 'location');
    deleteFieldRecursively(expectedSchemas['Person'], 'location');
    assert.deepEqual(schema, expectedSchemas['Person']);
  });

  it('restricts deeply nested schemas according to policy', async () => {
      const manifest = await Manifest.parse(`
        schema Name
          first: Text
          last: Text

        schema Address
          number: Number
          street: Text
          city: Text
          state: Text

        schema Person
          name: inline Name
          address: &Address

        schema Group
          persons: List<inline Person>

        policy MyPolicy {
          from Group access {
            persons {
              name {
                last
              },
              address {
                city
              }
            }
          }
        }`);
      const ingressValidation = new IngressValidation(manifest.policies);
      const maxReadSchemas = ingressValidation.maxReadSchemas;
      const expectedSchemas = (await Manifest.parse(`
        schema Name
          last: Text

        schema Address
          city: Text

        schema Person
          name: inline Name
          address: &Address

        schema Group
          persons: List<inline Person>
      `)).schemas;
    deleteFieldRecursively(maxReadSchemas['Group'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(expectedSchemas['Group'], 'location', {replaceWithNulls: true});
      assert.deepEqual(maxReadSchemas['Group'], expectedSchemas['Group']);
      // `Person` and `Name` are only referred to as an inline entities.
      // Therefore, they can only be written via `Group`. So, it is not
      // included in the max read schemas.
      //
      // On the other hand `Address` is a reference, and therefore, the
      // data might be written into a different store directly.
      // Therefore, we need to make sure that fields made accessible through
      // this policy are preserved by ingress restricting.
      assert.isFalse('Person' in maxReadSchemas);
      assert.isFalse('Name' in maxReadSchemas);
      assert.deepEqual(maxReadSchemas['Address'], expectedSchemas['Address']);
  });

  it('restricts types according to multiple policies', async () => {
    const policies = (await Manifest.parse(`
      schema Address
        number: Number
        street: Text
        city: Text
        zip: Number
        state: Text
        country: Text

      schema Person
        name: Text
        phone: Text
        address: &Address
        otherAddresses: [&Address {street, city, country}]

      policy PolicyOne {
        from Person access {
          name,
          address {
            number,
            street
          }
        }
      }

      policy PolicyTwo {
        from Person access {
          address {
            street,
            city
          },
          otherAddresses {city}
        }
      }

      policy PolicyThree {
        from Person access {
          name,
          otherAddresses {country}
        }
      }

      policy PolicyFour {
        from Address access {
          state
        }
      }`)).policies;
    const ingressValidation = new IngressValidation(policies);
    const maxReadSchemas = ingressValidation.maxReadSchemas;
    const expectedSchemas = (await Manifest.parse(`
      schema Address
        number: Number
        street: Text
        state: Text
        city: Text
        country: Text

      schema Person
        name: Text
        address: &Address {number, street, city}
        otherAddresses: [&Address {city, country}]
      `)).schemas;
    deleteFieldRecursively(maxReadSchemas['Person'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(expectedSchemas['Person'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(maxReadSchemas['Address'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(expectedSchemas['Address'], 'location', {replaceWithNulls: true});
    assert.deepEqual(maxReadSchemas['Person'], expectedSchemas['Person']);
    assert.deepEqual(maxReadSchemas['Address'], expectedSchemas['Address']);
  });

  it('does not add nested inline entities to max read schemas', async () => {
    const manifest = await Manifest.parse(`
      schema Address
        number: Number
        street: Text
        city: Text
        country: Text

      schema Name
        first: Text
        last: Text

      schema Person
        name: inline Name
        phone: Text
        addresses: List<inline Address>

      policy MyPolicy {
        from Person access {
          name {
            last
          },
          addresses {
            number
            street,
            city
          },
        }
      }

      policy AddressPolicy {
        from Address access {
            city,
            country
        }
      }`);
    const ingressValidation = new IngressValidation(manifest.policies);
    const maxReadSchemas = ingressValidation.maxReadSchemas;
    const expectedSchemas = (await Manifest.parse(`
      schema Address
        city: Text
        country: Text

      schema Person
        name: inline Name {last: Text}
        addresses: List<inline Address {number: Number, street: Text, city: Text}>
    `)).schemas;
    deleteFieldRecursively(maxReadSchemas['Person'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(expectedSchemas['Person'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(maxReadSchemas['Address'], 'location', {replaceWithNulls: true});
    deleteFieldRecursively(expectedSchemas['Address'], 'location', {replaceWithNulls: true});
    assert.deepEqual(maxReadSchemas['Person'], expectedSchemas['Person']);
    assert.deepEqual(maxReadSchemas['Address'], expectedSchemas['Address']);
    // 'Name' is not in `maxReadSchemas` because it only appears as
    // an inline entity.
    assert.isFalse('Name' in maxReadSchemas);
  });

  it('adds references in inline entities to max read schema', async () => {
      const manifest = await Manifest.parse(`
        schema Name
          first: Text
          last: Text

        schema Person
          name: &Name
          phone: Text

        schema Group
          persons: List<inline Person>

        policy MyPolicy {
          from Group access {
            persons {
              name {
                last
              }
            }
          }
        }`);
      const ingressValidation = new IngressValidation(manifest.policies);
      const maxReadSchemas = ingressValidation.maxReadSchemas;
      const expectedSchemas = (await Manifest.parse(`
        schema Name
          last: Text

        schema Person
          name: &Name

        schema Group
          persons: List<inline Person>
      `)).schemas;
      deleteFieldRecursively(maxReadSchemas['Group'], 'location', {replaceWithNulls: true});
      deleteFieldRecursively(expectedSchemas['Group'], 'location', {replaceWithNulls: true});
      assert.deepEqual(maxReadSchemas['Group'], expectedSchemas['Group']);
      // `Person` is only referred to as an inline entity. Therefore, it
      // can only be written via `Group`. So, it is not included in the
      // max read schemas.
      //
      // On the other hand `Name` is a reference, and therefore, the
      // data might be written into a different store directly.
      // Therefore, we need to make sure that fields made accessible through
      // this policy are preserved by ingress restricting.
      assert.isFalse('Person' in maxReadSchemas);
      assert.deepEqual(maxReadSchemas['Name'], expectedSchemas['Name']);
    });
});
