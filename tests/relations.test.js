import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runEntityCommand } from '../dist/cli/entity.js';
import { runNewCommand } from '../dist/cli/new.js';
import { ProjectConfigSchema } from '../dist/core/config.js';
import { buildEntityModels } from '../dist/core/entity-model.js';

const logger = { debug() {}, info() {}, success() {}, warn() {} };

function models(entities) {
  return buildEntityModels(ProjectConfigSchema.parse({ name: 'shop', entities }).entities);
}

async function generateProject(cwd) {
  await writeFile(
    path.join(cwd, 'cleanstack.config.json'),
    JSON.stringify({
      name: 'demo',
      packageName: 'com.example',
      entities: [],
      options: {
        backend: true,
        frontend: true,
        database: 'h2',
        auth: 'none',
        buildTool: 'maven',
        docker: false,
        dryRun: false,
        outputDir: '.',
      },
    }),
  );
  await runNewCommand(['demo', '--yes', '--no-entities'], { cwd, logger });
  return path.join(cwd, 'demo');
}

async function readProjectFile(projectRoot, relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('resolves owning sides, mappedBy, join columns, and join tables', () => {
  const [product, category, tag, user, profile] = models([
    {
      name: 'Product',
      fields: [{ name: 'name', type: 'String', required: true }],
      relations: [
        { field: 'category', type: 'ManyToOne', target: 'Category', required: true },
        { field: 'tags', type: 'ManyToMany', target: 'Tag' },
      ],
    },
    {
      name: 'Category',
      fields: [{ name: 'name', type: 'String' }],
      relations: [{ field: 'products', type: 'OneToMany', target: 'Product' }],
    },
    { name: 'Tag', fields: [{ name: 'name', type: 'String' }] },
    {
      name: 'User',
      fields: [{ name: 'email', type: 'String', required: true }],
      relations: [{ field: 'profile', type: 'OneToOne', target: 'Profile', required: true }],
    },
    {
      name: 'Profile',
      fields: [{ name: 'bio', type: 'String' }],
      relations: [{ field: 'user', type: 'OneToOne', target: 'User', inverse: true }],
    },
  ]);

  const productCategory = product.relations.find((relation) => relation.field === 'category');
  assert.equal(productCategory.owningSide, true);
  assert.equal(productCategory.joinColumnName, 'category_id');
  assert.equal(productCategory.idField, 'categoryId');
  assert.equal(productCategory.labelField, 'categoryLabel');
  assert.equal(productCategory.targetEntity.labelField, 'name');

  const productTags = product.relations.find((relation) => relation.field === 'tags');
  assert.equal(productTags.collection, true);
  assert.equal(productTags.joinTableName, 'products_tags');
  assert.equal(productTags.joinTableJoinColumn, 'product_id');
  assert.equal(productTags.joinTableInverseColumn, 'tag_id');
  assert.equal(productTags.idField, 'tagIds');
  assert.equal(productTags.labelField, 'tagLabels');
  assert.deepEqual(
    product.joinTables.map((table) => table.name),
    ['products_tags'],
  );

  const categoryProducts = category.relations[0];
  assert.equal(categoryProducts.owningSide, false);
  assert.equal(categoryProducts.mappedByField, 'category');
  assert.equal(categoryProducts.idField, 'productIds');

  const userProfile = user.relations[0];
  assert.equal(userProfile.owningSide, true);
  assert.equal(userProfile.joinColumnName, 'profile_id');
  assert.equal(profile.relations[0].owningSide, false);
  assert.equal(profile.relations[0].mappedByField, 'profile');

  assert.equal(tag.relations.length, 0);
  assert.equal(category.hasCollections, true);
  assert.deepEqual(
    product.mapperRepositories.map((repository) => repository.variableName),
    ['categoryRepository', 'tagRepository'],
  );
});

test('infers many-to-many and one-to-many mappedBy from the owning side', () => {
  const [, category, tag] = models([
    {
      name: 'Product',
      fields: [{ name: 'name', type: 'String' }],
      relations: [
        { field: 'category', type: 'ManyToOne', target: 'Category' },
        { field: 'tags', type: 'ManyToMany', target: 'Tag' },
      ],
    },
    {
      name: 'Category',
      fields: [],
      relations: [{ field: 'products', type: 'OneToMany', target: 'Product' }],
    },
    {
      name: 'Tag',
      fields: [],
      relations: [{ field: 'products', type: 'ManyToMany', target: 'Product', inverse: true }],
    },
  ]);

  assert.equal(category.relations[0].mappedByField, 'category');
  assert.equal(tag.relations[0].mappedByField, 'tags');
});

test('rejects an inverse relation without a matching mappedBy', () => {
  assert.throws(
    () =>
      models([
        {
          name: 'Profile',
          fields: [],
          relations: [{ field: 'user', type: 'OneToOne', target: 'User', inverse: true }],
        },
        { name: 'User', fields: [] },
      ]),
    /needs a "mappedBy" value/,
  );
});

test('generates backend and frontend code for every relation type', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-relations-'));
  try {
    const projectRoot = await generateProject(cwd);
    const entitiesDirectory = path.join(projectRoot, 'entities');
    await mkdir(entitiesDirectory, { recursive: true });

    const descriptors = {
      'Category.yaml': [
        'name: Category',
        'fields:',
        '  - name: name',
        '    type: String',
        '    required: true',
        'relations:',
        '  - type: OneToMany',
        '    target: Product',
        '    field: products',
        '',
      ].join('\n'),
      'Tag.yaml': [
        'name: Tag',
        'fields:',
        '  - name: name',
        '    type: String',
        '    required: true',
        'relations:',
        '  - type: ManyToMany',
        '    target: Product',
        '    field: products',
        '    inverse: true',
        '',
      ].join('\n'),
      'Profile.yaml': [
        'name: Profile',
        'fields:',
        '  - name: bio',
        '    type: String',
        'relations:',
        '  - type: OneToOne',
        '    target: User',
        '    field: user',
        '    inverse: true',
        '',
      ].join('\n'),
      'User.yaml': [
        'name: User',
        'fields:',
        '  - name: email',
        '    type: String',
        '    required: true',
        'relations:',
        '  - type: OneToOne',
        '    target: Profile',
        '    field: profile',
        '    required: true',
        '',
      ].join('\n'),
      'Product.yaml': [
        'name: Product',
        'fields:',
        '  - name: name',
        '    type: String',
        '    required: true',
        '  - name: price',
        '    type: BigDecimal',
        '    required: true',
        'relations:',
        '  - type: ManyToOne',
        '    target: Category',
        '    field: category',
        '    required: true',
        '  - type: ManyToMany',
        '    target: Tag',
        '    field: tags',
        '',
      ].join('\n'),
    };

    for (const [fileName, contents] of Object.entries(descriptors)) {
      await writeFile(path.join(entitiesDirectory, fileName), contents);
    }

    for (const entity of ['Category', 'Tag', 'Profile', 'User', 'Product']) {
      await runEntityCommand([entity], { cwd: projectRoot, logger });
    }

    const backend = 'demo-backend/src/main/java/com/example';
    const productEntity = await readProjectFile(projectRoot, `${backend}/domain/Product.java`);
    assert.match(productEntity, /@ManyToOne\(optional = false\)/);
    assert.match(productEntity, /@JoinColumn\(name = "category_id", nullable = false\)/);
    assert.match(productEntity, /@ManyToMany\(fetch = FetchType\.EAGER\)/);
    assert.match(productEntity, /name = "products_tags"/);
    assert.match(productEntity, /private List<Tag> tags = new ArrayList<>\(\);/);
    assert.match(
      productEntity,
      /public Product\(UUID id, String name, BigDecimal price, Category category, List<Tag> tags\)/,
    );

    const categoryEntity = await readProjectFile(projectRoot, `${backend}/domain/Category.java`);
    assert.match(categoryEntity, /@OneToMany\(mappedBy = "category", fetch = FetchType\.EAGER\)/);
    assert.match(categoryEntity, /private List<Product> products = new ArrayList<>\(\);/);

    const tagEntity = await readProjectFile(projectRoot, `${backend}/domain/Tag.java`);
    assert.match(tagEntity, /@ManyToMany\(mappedBy = "tags", fetch = FetchType\.EAGER\)/);

    const userEntity = await readProjectFile(projectRoot, `${backend}/domain/User.java`);
    assert.match(userEntity, /@OneToOne\(optional = false\)/);
    assert.match(userEntity, /@JoinColumn\(name = "profile_id", nullable = false, unique = true\)/);

    const profileEntity = await readProjectFile(projectRoot, `${backend}/domain/Profile.java`);
    assert.match(profileEntity, /@OneToOne\(mappedBy = "profile"\)/);

    const request = await readProjectFile(projectRoot, `${backend}/web/dto/ProductRequest.java`);
    assert.match(request, /@NotNull UUID categoryId/);
    assert.match(request, /List<UUID> tagIds/);
    assert.doesNotMatch(request, /products/);

    const response = await readProjectFile(projectRoot, `${backend}/web/dto/ProductResponse.java`);
    assert.match(response, /UUID categoryId/);
    assert.match(response, /String categoryLabel/);
    assert.match(response, /List<UUID> tagIds/);
    assert.match(response, /List<String> tagLabels/);

    const mapper = await readProjectFile(projectRoot, `${backend}/web/mapper/ProductMapper.java`);
    assert.match(mapper, /private final CategoryRepository categoryRepository;/);
    assert.match(mapper, /private final TagRepository tagRepository;/);
    assert.match(mapper, /categoryRepository\.getReferenceById\(request\.categoryId\(\)\)/);
    assert.match(mapper, /tagRepository\.findAllById\(request\.tagIds\(\)\)/);
    assert.match(mapper, /entity\.getCategory\(\)\.getName\(\)/);
    assert.match(
      mapper,
      /entity\.getTags\(\)\.stream\(\)\.map\(item -> item\.getName\(\)\)\.toList\(\)/,
    );

    const migration = await readProjectFile(
      projectRoot,
      'demo-backend/src/main/resources/db/migration/V6__create_products_table.sql',
    );
    assert.match(migration, /category_id UUID NOT NULL/);
    assert.match(
      migration,
      /ALTER TABLE products ADD CONSTRAINT fk_products_category_id FOREIGN KEY \(category_id\) REFERENCES categories \(id\);/,
    );
    assert.match(migration, /CREATE TABLE products_tags \(/);
    assert.match(migration, /PRIMARY KEY \(product_id, tag_id\)/);
    assert.match(migration, /ON DELETE CASCADE/);

    const ui = 'demo-ui/src/app';
    const model = await readProjectFile(projectRoot, `${ui}/models/product.ts`);
    assert.match(model, /categoryId: string \| null;/);
    assert.match(model, /categoryLabel: string \| null;/);
    assert.match(model, /tagIds: string\[\];/);
    assert.match(model, /tagLabels: string\[\];/);
    assert.match(model, /categoryId: string \| null;/);
    assert.match(model, /tagIds\?: string\[\];/);
    assert.doesNotMatch(model, /products/);

    const tagModel = await readProjectFile(projectRoot, `${ui}/models/tag.ts`);
    assert.match(tagModel, /productIds: string\[\];/);
    assert.doesNotMatch(tagModel, /products\?:/);

    const form = await readProjectFile(projectRoot, `${ui}/pages/products/form/form.component.ts`);
    assert.match(form, /readonly categoryOptions = signal/);
    assert.match(form, /readonly tagOptions = signal/);
    assert.match(form, /categoryId: \['', \[Validators\.required\]\]/);
    assert.match(form, /tagIds: \[\[\] as string\[\]\]/);
    assert.match(form, /this\.categoryService\.list\(\)/);
    assert.match(form, /this\.tagService\.list\(\)/);
    assert.match(form, /const input: ProductInput = \{/);
    assert.match(form, /categoryId: raw\.categoryId === '' \? null : raw\.categoryId/);

    const formHtml = await readProjectFile(
      projectRoot,
      `${ui}/pages/products/form/form.component.html`,
    );
    assert.match(formHtml, /<select formControlName="categoryId">/);
    assert.match(formHtml, /<select multiple formControlName="tagIds"/);
    assert.match(formHtml, /@for \(option of categoryOptions\(\); track option\.id\)/);
    assert.match(formHtml, /@for \(option of tagOptions\(\); track option\.id\)/);

    const tagFormHtml = await readProjectFile(
      projectRoot,
      `${ui}/pages/tags/form/form.component.html`,
    );
    assert.doesNotMatch(tagFormHtml, /<select/);

    const listHtml = await readProjectFile(
      projectRoot,
      `${ui}/pages/products/list/list.component.html`,
    );
    assert.match(listHtml, /product\.categoryLabel \?\? '—'/);
    assert.match(listHtml, /product\.tagLabels\.length \? product\.tagLabels\.join\(', '\) : '—'/);

    const detailHtml = await readProjectFile(
      projectRoot,
      `${ui}/pages/products/detail/detail.component.html`,
    );
    assert.match(detailHtml, /product\.categoryLabel \?\? '—'/);
    assert.match(
      detailHtml,
      /product\.tagLabels\.length \? product\.tagLabels\.join\(', '\) : '—'/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('orders migrations so related tables exist before foreign keys', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-relations-order-'));
  try {
    await writeFile(
      path.join(cwd, 'cleanstack.config.json'),
      JSON.stringify({
        name: 'ordered',
        packageName: 'com.example',
        entities: [
          {
            name: 'Product',
            fields: [{ name: 'name', type: 'String', required: true }],
            relations: [{ field: 'category', type: 'ManyToOne', target: 'Category' }],
          },
          {
            name: 'Category',
            fields: [{ name: 'name', type: 'String', required: true }],
          },
        ],
        options: {
          backend: true,
          frontend: false,
          database: 'h2',
          auth: 'none',
          buildTool: 'maven',
          docker: false,
          dryRun: false,
          outputDir: '.',
        },
      }),
    );

    await runNewCommand(['demo', '--yes'], { cwd, logger });
    const projectRoot = path.join(cwd, 'demo');

    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/migration/V2__create_categories_table.sql',
      ),
      /CREATE TABLE categories/,
    );
    const productMigration = await readProjectFile(
      projectRoot,
      'demo-backend/src/main/resources/db/migration/V3__create_products_table.sql',
    );
    assert.match(productMigration, /category_id UUID/);
    assert.match(productMigration, /REFERENCES categories \(id\)/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
