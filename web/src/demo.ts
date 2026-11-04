import type { EntityConfig, FieldConfig, GenerationOptions } from '../../src/core/config';
import type {
  EntityDefinitionRequest,
  EntityPreviewResponse,
  MetaResponse,
  ProjectFile,
  ProjectFileResponse,
  ProjectFilesResponse,
  ProjectSummary,
  WorkspaceResponse,
} from '../../src/web/contracts';

/**
 * Bundled data for the pure static demo. The real studio always renders and
 * generates through the local engine; these fixtures only exist so the UI can
 * be hosted without a Node server.
 */

const DEMO_WORKSPACE_PATH = '/demo/cleanstack-showcase';

function options(overrides: Partial<GenerationOptions> = {}): GenerationOptions {
  return {
    backend: true,
    frontend: true,
    database: 'postgresql',
    auth: 'jwt',
    buildTool: 'maven',
    docker: false,
    dryRun: false,
    outputDir: '.',
    ...overrides,
  };
}

function field(
  name: string,
  type: FieldConfig['type'],
  extras: Omit<Partial<FieldConfig>, 'name' | 'type'> = {},
): FieldConfig {
  const required = extras.required ?? false;
  return {
    name,
    type,
    required,
    nullable: !required,
    unique: false,
    generated: false,
    validations: [],
    ...extras,
  };
}

type Relation = EntityConfig['relations'][number];

function relation(
  fieldName: string,
  type: Relation['type'],
  target: string,
  extras: Partial<Relation> = {},
): Relation {
  return {
    field: fieldName,
    type,
    target,
    required: false,
    inverse: false,
    ...extras,
  };
}

const product: EntityConfig = {
  name: 'Product',
  tableName: 'products',
  fields: [
    field('name', 'String', {
      required: true,
      unique: true,
      maxLength: 120,
      validations: ['NotBlank'],
    }),
    field('sku', 'String', { required: true, unique: true, maxLength: 40 }),
    field('price', 'BigDecimal', { required: true, min: 0, validations: ['PositiveOrZero'] }),
    field('description', 'String', { maxLength: 2000 }),
    field('active', 'boolean', { required: true }),
  ],
  relations: [relation('category', 'many-to-one', 'Category', { required: true })],
};

const category: EntityConfig = {
  name: 'Category',
  tableName: 'categories',
  fields: [
    field('name', 'String', { required: true, maxLength: 80, validations: ['NotBlank'] }),
    field('slug', 'String', { required: true, unique: true, maxLength: 80 }),
  ],
  relations: [
    relation('products', 'one-to-many', 'Product', { inverse: true, mappedBy: 'category' }),
  ],
};

const review: EntityConfig = {
  name: 'Review',
  tableName: 'reviews',
  fields: [
    field('rating', 'int', { required: true, min: 1, max: 5 }),
    field('comment', 'String', { maxLength: 1000 }),
    field('createdAt', 'LocalDateTime', { required: true, generated: true }),
  ],
  relations: [relation('product', 'many-to-one', 'Product', { required: true })],
};

const note: EntityConfig = {
  name: 'Note',
  tableName: 'notes',
  fields: [
    field('title', 'String', { required: true, maxLength: 160, validations: ['NotBlank'] }),
    field('body', 'String', { maxLength: 4000 }),
    field('pinned', 'boolean', { required: true }),
    field('createdAt', 'LocalDateTime', { required: true, generated: true }),
  ],
  relations: [],
};

const ACME_ROOT = `${DEMO_WORKSPACE_PATH}/acme-shop`;
const NOTES_ROOT = `${DEMO_WORKSPACE_PATH}/notes-api`;

const demoProjects: ProjectSummary[] = [
  {
    name: 'acme-shop',
    rootDir: ACME_ROOT,
    relativePath: 'acme-shop',
    packageName: 'com.acme.shop',
    backend: true,
    frontend: true,
    backendDirectory: 'acme-shop-backend',
    frontendDirectory: 'acme-shop-ui',
    entities: [category, product, review],
    options: options({ docker: true }),
  },
  {
    name: 'notes-api',
    rootDir: NOTES_ROOT,
    relativePath: 'notes-api',
    packageName: 'com.acme.notes',
    backend: true,
    frontend: false,
    backendDirectory: 'notes-api-backend',
    frontendDirectory: null,
    entities: [note],
    options: options({
      frontend: false,
      database: 'h2',
      auth: 'none',
      buildTool: 'gradle',
    }),
  },
];

const PROJECT_FILES: Record<string, Record<string, string>> = {
  [ACME_ROOT]: {
    'README.md': `# acme-shop

A CleanStack full-stack project generated with Spring Boot and Angular.

## Stack

- Spring Boot backend with JPA, Flyway, and Bean Validation
- Angular standalone frontend with hash routing
- PostgreSQL database
- JWT resource server security
- Docker Compose development services

## Run locally

    docker compose up -d
    cd acme-shop-backend && mvn spring-boot:run
    cd acme-shop-ui && npm start

Entities: Category, Product, Review.
`,
    '.cleanstack/project.json': `{
  "version": 1,
  "config": {
    "name": "acme-shop",
    "packageName": "com.acme.shop",
    "options": {
      "backend": true,
      "frontend": true,
      "database": "postgresql",
      "auth": "jwt",
      "buildTool": "maven",
      "docker": true,
      "dryRun": false,
      "outputDir": "."
    }
  }
}
`,
    'acme-shop-backend/pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.4.1</version>
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>acme-shop-backend</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <dependency>
      <groupId>org.flywaydb</groupId>
      <artifactId>flyway-core</artifactId>
    </dependency>
  </dependencies>
</project>
`,
    'acme-shop-backend/src/main/java/com/acme/shop/domain/Product.java': `package com.acme.shop.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToOne;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.PositiveOrZero;
import java.math.BigDecimal;

@Entity
public class Product {
  @Id
  @GeneratedValue
  private Long id;

  @NotBlank
  private String name;

  private String sku;

  @PositiveOrZero
  private BigDecimal price;

  private String description;

  private boolean active;

  @ManyToOne(optional = false)
  private Category category;

  public Long getId() {
    return id;
  }

  public String getName() {
    return name;
  }

  public void setName(String name) {
    this.name = name;
  }

  public Category getCategory() {
    return category;
  }
}
`,
    'acme-shop-backend/src/main/java/com/acme/shop/domain/Category.java': `package com.acme.shop.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.validation.constraints.NotBlank;
import java.util.ArrayList;
import java.util.List;

@Entity
public class Category {
  @Id
  @GeneratedValue
  private Long id;

  @NotBlank
  private String name;

  private String slug;

  @OneToMany(mappedBy = "category")
  private List<Product> products = new ArrayList<>();

  public Long getId() {
    return id;
  }

  public String getName() {
    return name;
  }

  public List<Product> getProducts() {
    return products;
  }
}
`,
    'acme-shop-backend/src/main/java/com/acme/shop/infrastructure/web/ProductController.java': `package com.acme.shop.infrastructure.web;

import com.acme.shop.domain.Product;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/products")
public class ProductController {
  @GetMapping
  public List<Product> list() {
    return List.of();
  }
}
`,
    'acme-shop-backend/src/main/resources/db/migration/V2__create_category_table.sql': `CREATE TABLE categories (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE
);
`,
    'acme-shop-backend/src/main/resources/db/migration/V3__create_product_table.sql': `CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  sku VARCHAR(40) NOT NULL UNIQUE,
  price NUMERIC(19, 2) NOT NULL,
  description VARCHAR(2000),
  active BOOLEAN NOT NULL,
  category_id BIGINT NOT NULL REFERENCES categories (id)
);
`,
    'acme-shop-ui/src/app/app.routes.ts': `import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'products' },
  {
    path: 'products',
    loadComponent: () =>
      import('./pages/products/list/list.component').then((m) => m.ProductListComponent),
  },
  {
    path: 'products/new',
    loadComponent: () =>
      import('./pages/products/form/form.component').then((m) => m.ProductFormComponent),
  },
];
`,
    'acme-shop-ui/src/app/models/product.ts': `export interface Product {
  id: number;
  name: string;
  sku: string;
  price: number;
  description: string | null;
  active: boolean;
  categoryId: number;
}
`,
    'acme-shop-ui/src/app/services/product.service.ts': `import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Product } from '../models/product';

@Injectable({ providedIn: 'root' })
export class ProductService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api/products';

  list(): Observable<Product[]> {
    return this.http.get<Product[]>(this.baseUrl);
  }

  get(id: number): Observable<Product> {
    return this.http.get<Product>(this.baseUrl + '/' + id);
  }
}
`,
    'acme-shop-ui/src/app/pages/products/list/list.component.ts': `import { Component, inject, signal } from '@angular/core';
import { Product } from '../../../models/product';
import { ProductService } from '../../../services/product.service';

@Component({
  selector: 'app-product-list',
  standalone: true,
  templateUrl: './list.component.html',
})
export class ProductListComponent {
  private readonly service = inject(ProductService);
  readonly products = signal<Product[]>([]);

  constructor() {
    this.service.list().subscribe((products) => this.products.set(products));
  }
}
`,
    'acme-shop-ui/src/app/pages/products/form/form.component.html': `<form class="entity-form" (ngSubmit)="save()">
  <label>
    <span>Name</span>
    <input name="name" [(ngModel)]="model.name" required maxlength="120" />
  </label>
  <label>
    <span>SKU</span>
    <input name="sku" [(ngModel)]="model.sku" required maxlength="40" />
  </label>
  <label>
    <span>Price</span>
    <input name="price" type="number" min="0" [(ngModel)]="model.price" required />
  </label>
  <label>
    <span>Category</span>
    <select name="categoryId" [(ngModel)]="model.categoryId">
      <option *ngFor="let category of categories()" [value]="category.id">
        {{ category.name }}
      </option>
    </select>
  </label>
  <button type="submit">Save product</button>
</form>
`,
  },
  [NOTES_ROOT]: {
    'README.md': `# notes-api

A backend-only CleanStack project generated with Spring Boot and Gradle.

## Stack

- Spring Boot with JPA and Flyway
- H2 in-memory database
- No authentication
- Single Note entity with generated timestamps

## Run locally

    cd notes-api-backend
    ./gradlew bootRun

The API is available at http://localhost:8080/api/notes.
`,
    '.cleanstack/project.json': `{
  "version": 1,
  "config": {
    "name": "notes-api",
    "packageName": "com.acme.notes",
    "options": {
      "backend": true,
      "frontend": false,
      "database": "h2",
      "auth": "none",
      "buildTool": "gradle",
      "docker": false,
      "dryRun": false,
      "outputDir": "."
    }
  }
}
`,
    'notes-api-backend/build.gradle.kts': `plugins {
    java
    id("org.springframework.boot") version "3.4.1"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.acme"
version = "0.0.1-SNAPSHOT"

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.flywaydb:flyway-core")
    runtimeOnly("com.h2database:h2")
}
`,
    'notes-api-backend/src/main/java/com/acme/notes/domain/Note.java': `package com.acme.notes.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.validation.constraints.NotBlank;
import java.time.LocalDateTime;

@Entity
public class Note {
  @Id
  @GeneratedValue
  private Long id;

  @NotBlank
  private String title;

  private String body;

  private boolean pinned;

  private LocalDateTime createdAt;

  public Long getId() {
    return id;
  }

  public String getTitle() {
    return title;
  }

  public LocalDateTime getCreatedAt() {
    return createdAt;
  }
}
`,
    'notes-api-backend/src/main/resources/db/migration/V2__create_note_table.sql': `CREATE TABLE notes (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  body VARCHAR(4000),
  pinned BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL
);
`,
    'notes-api-backend/src/main/resources/application.yml': `spring:
  datasource:
    url: jdbc:h2:mem:notes
  jpa:
    hibernate:
      ddl-auto: validate
  flyway:
    enabled: true
`,
  },
};

const FIELD_TYPES = [
  'String',
  'boolean',
  'Boolean',
  'byte',
  'Byte',
  'short',
  'Short',
  'int',
  'Integer',
  'long',
  'Long',
  'BigInteger',
  'float',
  'Float',
  'double',
  'Double',
  'BigDecimal',
  'UUID',
  'LocalDate',
  'LocalTime',
  'LocalDateTime',
  'OffsetDateTime',
  'Instant',
];

const FIELD_VALIDATIONS = [
  'NotBlank',
  'Email',
  'Positive',
  'PositiveOrZero',
  'Negative',
  'NegativeOrZero',
  'Past',
  'PastOrPresent',
  'Future',
  'FutureOrPresent',
];

const DEMO_META: MetaResponse = {
  fieldTypes: FIELD_TYPES,
  validations: FIELD_VALIDATIONS,
  databases: ['postgresql', 'mysql', 'h2'],
  authMethods: ['jwt', 'none', 'keycloak'],
  buildTools: ['maven', 'gradle'],
  defaults: options({ docker: false }),
  capabilities: {
    localGeneration: false,
    archiveDownload: false,
  },
};

export function demoWorkspace(): WorkspaceResponse {
  return {
    workspacePath: DEMO_WORKSPACE_PATH,
    workspaceName: 'cleanstack-showcase',
    projects: demoProjects,
  };
}

export function demoMeta(): MetaResponse {
  return DEMO_META;
}

export function demoProject(projectPath: string): ProjectSummary {
  return findProject(projectPath);
}

export function demoProjectFiles(projectPath: string): ProjectFilesResponse {
  const project = findProject(projectPath);
  const contents = PROJECT_FILES[project.rootDir] ?? {};
  const files = Object.keys(contents)
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => fileEntry(filePath, contents[filePath]!));
  return { project, files, truncated: false };
}

export function demoProjectFile(projectPath: string, filePath: string): ProjectFileResponse {
  const project = findProject(projectPath);
  const contents = PROJECT_FILES[project.rootDir] ?? {};
  const content = contents[filePath];
  if (content === undefined) {
    throw new Error(`"${filePath}" is not part of the bundled static demo.`);
  }
  return {
    project,
    file: fileEntry(filePath, content),
    content,
    binary: false,
    truncated: false,
  };
}

export function demoEntityPreview(definition: EntityDefinitionRequest): EntityPreviewResponse {
  return {
    yaml: serializeEntityDescriptor(definition),
    files: [],
  };
}

function findProject(projectPath: string): ProjectSummary {
  return demoProjects.find((project) => project.rootDir === projectPath) ?? demoProjects[0]!;
}

function fileEntry(filePath: string, content: string): ProjectFile {
  const name = filePath.split('/').at(-1) ?? filePath;
  const separator = name.lastIndexOf('.');
  return {
    path: filePath,
    size: new TextEncoder().encode(content).length,
    extension: separator === -1 ? '' : name.slice(separator + 1).toLowerCase(),
  };
}

const SAFE_SCALAR = /^[A-Za-z0-9_./-]+$/;
const RESERVED_SCALARS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']);

function yamlScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    return SAFE_SCALAR.test(value) && !RESERVED_SCALARS.has(value.toLowerCase())
      ? value
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/** Mirrors the descriptor serialization used by the local engine. */
function serializeEntityDescriptor(definition: EntityDefinitionRequest): string {
  const lines: string[] = [`name: ${yamlScalar(definition.name)}`];
  if (definition.tableName !== undefined) {
    lines.push(`tableName: ${yamlScalar(definition.tableName)}`);
  }

  lines.push('fields:');
  for (const fieldDefinition of definition.fields) {
    lines.push(`  - name: ${yamlScalar(fieldDefinition.name)}`);
    lines.push(`    type: ${yamlScalar(fieldDefinition.type)}`);
    if (fieldDefinition.required) lines.push('    required: true');
    if (fieldDefinition.unique) lines.push('    unique: true');
    if (fieldDefinition.default !== undefined) {
      lines.push(`    default: ${yamlScalar(fieldDefinition.default)}`);
    }
    if (fieldDefinition.generated) lines.push('    generated: true');
    if (fieldDefinition.minLength !== undefined) {
      lines.push(`    minLength: ${yamlScalar(fieldDefinition.minLength)}`);
    }
    if (fieldDefinition.maxLength !== undefined) {
      lines.push(`    maxLength: ${yamlScalar(fieldDefinition.maxLength)}`);
    }
    if (fieldDefinition.min !== undefined)
      lines.push(`    min: ${yamlScalar(fieldDefinition.min)}`);
    if (fieldDefinition.max !== undefined)
      lines.push(`    max: ${yamlScalar(fieldDefinition.max)}`);
    if (fieldDefinition.pattern !== undefined) {
      lines.push(`    pattern: ${yamlScalar(fieldDefinition.pattern)}`);
    }
    if (fieldDefinition.validations !== undefined && fieldDefinition.validations.length > 0) {
      lines.push('    validations:');
      for (const validation of fieldDefinition.validations) {
        lines.push(`      - ${yamlScalar(validation)}`);
      }
    }
  }

  if (definition.relations.length > 0) {
    lines.push('relations:');
    for (const relationDefinition of definition.relations) {
      lines.push(`  - field: ${yamlScalar(relationDefinition.field)}`);
      lines.push(`    type: ${yamlScalar(relationDefinition.type)}`);
      lines.push(`    target: ${yamlScalar(relationDefinition.target)}`);
      if (relationDefinition.required) lines.push('    required: true');
      if (relationDefinition.mappedBy !== undefined) {
        lines.push(`    mappedBy: ${yamlScalar(relationDefinition.mappedBy)}`);
      }
      if (relationDefinition.inverse) lines.push('    inverse: true');
    }
  }

  return `${lines.join('\n')}\n`;
}
